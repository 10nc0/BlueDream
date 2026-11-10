'use strict';

const { PHI_BREATHE, MISC } = require('../config/constants');
const logger = require('./logger');
const { VALID_SCHEMA_PATTERN } = require('./validators');
const { runMonthlyClosing } = require('./monthly-closing');
const { runMonthlyEmail } = require('./monthly-email');
const nyanBus = require('./nyan-bus');
const { Worker } = require('node:worker_threads');
const { getActiveResolution } = require('./db-resolver');

// ── PhiBreathe — dual role ────────────────────────────────────────────────────
//
// ROLE 1 — Background scheduler
//   subscribe(name, intervalMs, cb) fires housekeeping tasks (session cleanup,
//   media purge, monthly closing, etc.) on independent timers with circuit
//   breakers.  These are all cancellable and replaceable at runtime.
//
// ROLE 2 — Node-time anchor (load-bearing, not cosmetic)
//   `phiBreatheCount` is a monotonically increasing integer backed by an
//   atomic DB upsert in core.system_counters ('phi_breathe_count').  It is
//   stamped onto every processed packet:
//
//     • anatta_messages.phi_breathe_stamp  (tenant schema)
//     • drops.phi_breathe_stamp            (tenant schema, migration 006)
//     • core.message_ledger                (shared ledger row, packet-queue.js)
//     • message fractal ID _b{N}_ segment  (utils/fractal-id.js)
//
//   This creates a tamper-evident Lamport-like counter: to verify that a
//   packet arrived when the node claims, cross-check the _b{N}_ in its
//   fractal ID against the core.system_counters log for that time window.
//   A replayed or backdated packet would carry an N that is out of range for
//   the claimed wall-clock timestamp.
//
//   Dev mode deliberately keeps the counter ephemeral (worker memory, no DB
//   write) because the queue processor is disabled in dev — no packets are
//   stamped, so the counter does not need to be durable or contiguous.
//   Prod packets must never mix with a dev counter range.
//
// Leader election uses a DB-time lease fenced atomically with each increment.
// A transaction advisory guard also respects the previous session-lock leader
// during rollout. No session lock is retained through a transaction pooler.

class PhiBreathe {
    constructor() {
        this.subscribers = new Map();
        this.intervals = new Map();
        this.phiBreatheCount = 0;
        this.pool = null;
        this.bots = {};
        this.cleanupFunctions = {};
        this.heartbeatCallback = null;
        this.isProduction = false; // Will be set properly in startPhiBreathe()
        this.initialized = false;
        this.closingGuard = new Map();
        this.nodes = new Map(); // NyanMesh node registry

        // Subscribe to heal:complete for heartbeat-level logging
        nyanBus.on('heal:complete', ({ bookId, channelId }) => {
            logger.info({ bookId, channelId }, '🏥 NyanMesh: heal:complete — book %s healed, channel %s', bookId, channelId);
        });
    }
    
    setPool(pool) {
        this.pool = pool;
    }

    setMaintenanceQueue(queue) { this.maintenanceQueue = queue; }
    setStartupObserver(callback) { this.startupObserver = callback; }
    isLeader() { return !this._stopped && this._owned && Date.now() - this._observedAt < 20000; }
    isCounterReady() { return !this._stopped && this.phiBreatheCount > 0 && Date.now() - this._observedAt < 20000; }
    _work(name, run, options) {
        const owned = () => this._stopped ? { skipped: 'shutdown' } :
            !options?.local && (!this.isProduction || !this.isLeader()) ? { skipped: 'not_leader' } : run();
        return this.maintenanceQueue ? this.maintenanceQueue.enqueue(name, owned, options) : Promise.resolve().then(owned);
    }
    retryMonthlyClosing() {
        if (!this._monthlyDueAt || this._stopped || !this.isLeader()) return;
        this._monthlyWork(this._monthlyDueAt).catch(err => logger.warn({ code: err.code }, 'Monthly work awaiting recovery'));
    }
    async _monthlyWork(at) {
        this._monthlyDueAt = at;
        const previous = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1));
        const overrideMonth = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth()+1).padStart(2,'0')}`;
        await Promise.all([
            this._work('monthly-closing', async () => {
                if (!this.bots.idris?.client?.isReady()) throw new Error('Monthly closing is waiting for Idris.');
                return runMonthlyClosing(this.pool, this.bots, { overrideMonth });
            }, { attempts: 8 }),
            this._work('monthly-email', () => runMonthlyEmail(this.pool, { overrideMonth }), { attempts: 8 })
        ]);
    }
    
    setBots(bots) {
        this.bots = bots;
    }
    
    setCleanupFunctions(cleanupFunctions) {
        this.cleanupFunctions = cleanupFunctions;
    }
    
    setHeartbeatCallback(callback) {
        this.heartbeatCallback = callback;
    }

    // ============================================================================
    // NYANMESH: In-process event bus + node registry
    // ============================================================================

    registerNode(name, meta = {}) {
        const now = Date.now();
        const { status: metaStatus, ...rest } = meta;
        const status = metaStatus || 'online';
        const entry = {
            name,
            status,
            readyAt: status === 'online' ? now : null,
            lastSeen: now,
            ...rest
        };
        this.nodes.set(name, entry);
        logger.info({ node: name, status }, '🔌 NyanMesh: node registered — %s (%s)', name, status);
        nyanBus.emit('mesh:node:up', { name, ...entry });
    }

    deregisterNode(name) {
        if (this.nodes.has(name)) {
            const entry = this.nodes.get(name);
            entry.status = 'offline';
            entry.lastSeen = Date.now();
            this.nodes.set(name, entry);
            logger.info({ node: name }, '🔌 NyanMesh: node offline — %s', name);
            nyanBus.emit('mesh:node:down', { name, ...entry });
        }
    }

    updateNodeStatus(name, ready) {
        if (this.nodes.has(name)) {
            const entry = this.nodes.get(name);
            const wasOffline = entry.status !== 'online';
            entry.status = ready ? 'online' : 'offline';
            entry.lastSeen = Date.now();
            // Set readyAt only when transitioning offline → online
            if (ready && wasOffline) {
                entry.readyAt = Date.now();
            }
            this.nodes.set(name, entry);
        }
    }

    emit(event, data) {
        return nyanBus.emit(event, data);
    }

    on(event, handler) {
        return nyanBus.on(event, handler);
    }

    off(event, handler) {
        return nyanBus.off(event, handler);
    }

    async _snapshotNodeRegistry() {
        if (!this.pool || this.nodes.size === 0) return;
        try {
            const registry = {};
            for (const [name, entry] of this.nodes) {
                registry[name] = entry;
            }
            // Single parameterized upsert — no string interpolation of node names.
            // Requires core.system_counters.meta JSONB column (migration 010).
            await this.pool.query(
                `INSERT INTO core.system_counters (key, value, meta, updated_at)
                 VALUES ('mesh_node_registry', 0, $1, NOW())
                 ON CONFLICT (key) DO UPDATE
                 SET meta = $1, updated_at = NOW()`,
                [JSON.stringify(registry)]
            );
            logger.debug({ nodeCount: this.nodes.size }, '🔌 NyanMesh: node registry snapshot written');
        } catch (err) {
            logger.warn({ err }, '⚠️ NyanMesh: node registry snapshot failed');
        }
    }

    subscribe(name, intervalMs, callback, options = {}) {
        if (this.subscribers.has(name)) {
            logger.warn({ subscriber: name }, '⚡ Phi breathe: subscriber already registered, replacing');
            this.unsubscribe(name);
        }
        
        this.subscribers.set(name, { intervalMs, callback, lastRun: 0, failures: 0 });
        
        const timer = setInterval(async () => {
            const sub = this.subscribers.get(name);
            if (!sub || sub.running || this._stopped) return;
            
            if (sub.failures >= 3) {
                logger.warn({ subscriber: name, failures: sub.failures }, '⚡ Circuit breaker: auto-unsubscribing after consecutive failures');
                this.unsubscribe(name);
                // Schedule one recovery attempt after 5-minute cooldown
                const COOLDOWN_MS = 5 * 60 * 1000;
                this.recoveryTimers ||= new Set();
                const recovery = setTimeout(() => {
                    this.recoveryTimers.delete(recovery);
                    if (this._stopped) return;
                    logger.info({ subscriber: name }, '⚡ Circuit breaker: cooldown elapsed — attempting re-registration');
                    this.subscribe(name, intervalMs, callback, options);
                }, COOLDOWN_MS);
                this.recoveryTimers.add(recovery);
                return;
            }
            
            try {
                sub.running = true;
                await this._work(name, callback, options);
                sub.lastRun = Date.now();
                sub.failures = 0;
            } catch (error) {
                sub.failures++;
                logger.error({ subscriber: name, failures: sub.failures, err: error }, 'Phi breathe subscriber error');
            } finally {
                sub.running = false;
            }
        }, intervalMs);
        
        this.intervals.set(name, timer);
        logger.info({ subscriber: name, cycleMinutes: Math.round(intervalMs / 1000 / 60) }, '🔔 Phi breathe: subscriber registered — %s', name);
    }
    
    unsubscribe(name) {
        const timer = this.intervals.get(name);
        if (timer) {
            clearInterval(timer);
            this.intervals.delete(name);
            this.subscribers.delete(name);
            logger.info({ subscriber: name }, 'Phi breathe: subscriber unsubscribed');
        }
    }
    
    // ============================================================================
    // PHI BREATHE RHYTHM: Modular orchestrator
    // ============================================================================
    async startPhiBreathe() {
        if (this._startPromise) return this._startPromise;
        if (this._worker || this._workerRecovery) return;
        if (this._workerStop) await this._workerStop;
        this._stopped = false;
        this.isProduction = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
        this._startPromise = this._spawnHeartbeat().finally(() => { this._startPromise = null; });
        return this._startPromise;
    }

    _spawnHeartbeat() {
        if (this._stopped) return Promise.resolve();
        const resolution = this.isProduction ? getActiveResolution() : null;
        if (this.isProduction && !resolution) return Promise.reject(new Error('Heartbeat requires a verified database source.'));
        this._owned = false;
        this._observedAt = 0;
        return new Promise(resolve => {
            // Do not inherit preload hooks or application credentials in the
            // worker environment. Only the verified DB configuration crosses IPC.
            const worker = new Worker(require.resolve('./heartbeat-worker'), {
                workerData: { production: this.isProduction, resolution, initialCount: this.phiBreatheCount }, env: {}, execArgv: []
            });
            this._worker = worker;
            worker.on('message', message => {
                if (message.kind === 'release-error') {
                    logger.warn({ code: message.code }, 'Heartbeat lease release failed; lease will expire');
                    return;
                }
                if (this._stopped || this._worker !== worker) return;
                if (message.kind === 'fatal') {
                    logger.error({ code: message.code }, 'Heartbeat worker initialization failed');
                    return;
                }
                if (message.kind !== 'observation') {
                    if (message.kind === 'overdue') logger.warn(`Heartbeat skipped ${message.missed} overdue slots; no catch-up writes`);
                    return;
                }
                this._observeHeartbeat(message);
                if (this.isCounterReady()) this._workerFailures = 0;
                resolve();
            });
            worker.on('error', error => {
                if (this._worker !== worker) return;
                this._owned = false;
                this._observedAt = 0;
                logger.error({ code: error.code }, 'Heartbeat worker failed; counter unavailable until recovery');
            });
            worker.on('exit', () => {
                resolve();
                if (this._worker !== worker) return;
                this._worker = null;
                this._owned = false;
                this._observedAt = 0;
                clearTimeout(this._monthlyTimer);
                this._scheduleHeartbeatRecovery();
            });
        });
    }

    _scheduleHeartbeatRecovery() {
        if (this._stopped || this._worker || this._workerRecovery) return;
        const delayMs = Math.min(30000, 2000 * 2 ** Math.min(this._workerFailures || 0, 4));
        this._workerFailures = (this._workerFailures || 0) + 1;
        this._workerRecovery = setTimeout(() => {
            this._workerRecovery = null;
            this._spawnHeartbeat().catch(error => {
                logger.error({ code: error.code }, 'Heartbeat recovery failed');
                this._scheduleHeartbeatRecovery();
            });
        }, delayMs);
    }

    _observeHeartbeat(message) {
        const wasLeader = this.isLeader();
        this._owned = !!message.owned && !!message.fresh;
        this._observedAt = message.fresh ? message.observedAt : 0;
        if (Number.isSafeInteger(message.count) && message.count > 0) this.phiBreatheCount = message.count;
        const deliveryMs = Math.max(0, Date.now() - (message.emittedAt || Date.now()));
        this.heartbeatTiming = { ...message, deliveryMs };
        if (message.code) {
            logger.warn({ code: message.code }, 'Heartbeat database unavailable; no breath published');
            return;
        }
        if (!message.owned) return; // Following a real shared count is not a local breath.
        const type = message.count % 2 ? 'inhale' : 'exhale';
        logger.info(`🌬️ phi breathe #${message.count} ${type} ${message.durationMs}ms`);
        if (!this.isCounterReady()) return; // Delayed IPC must not freshen stale observations.
        if (!wasLeader && this.isProduction) this._onLeadershipAcquired(message.emittedAt);
        try {
            Promise.resolve(this.startupObserver?.(this.heartbeatTiming)).catch(error =>
                logger.warn({ code: error.code }, 'Heartbeat startup observer failed'));
        }
        catch (error) { logger.warn({ code: error.code }, 'Heartbeat startup observer failed'); }
        if (message.count % 86 === 0) {
            this._work('heartbeat-checkpoint', async () => {
                try { await this.heartbeatCallback?.(message.count); }
                finally { await this._snapshotNodeRegistry(); }
            }, { local: !this.isProduction }).catch(error =>
                logger.warn({ code: error.code }, 'Heartbeat checkpoint failed'));
        }
    }

    _onLeadershipAcquired(emittedAt) {
        logger.info('Phi breathe: acquired fenced lease in independent worker');
        // Leader-takeover day-1 check: when a new instance wins the lock (startup
        // OR after a scale-induced takeover), immediately check whether a monthly
        // email is due. The 10-second delay lets the pool and bots settle before
        // running the potentially expensive closing + email jobs. The existing DB
        // guard (ON CONFLICT DO NOTHING) prevents double-execution.
        //
        // IMPORTANT: acquire date is captured NOW (before the delay) so that a
        // lock acquisition at 23:59:55 UTC on the 1st still triggers the run —
        // evaluating inside setTimeout would see day 2 after the 10s window.
        if (this.pool && new Date(emittedAt).getUTCDate() === 1) {
            const acquiredAt = new Date(emittedAt);
            clearTimeout(this._monthlyTimer);
            this._monthlyTimer = setTimeout(async () => {
                if (this._stopped || !this.isLeader()) return;
                if (acquiredAt.getUTCDate() !== 1) return;
                logger.info({ acquiredAt }, '🫀 Phi breathe: leader lock acquired on 1st — running monthly tasks (takeover path)');
                try {
                    await this._monthlyWork(acquiredAt);
                } catch (err) {
                    logger.error({ err }, '📧 Monthly email: error on leader-takeover day-1 check');
                }
            }, 10_000);
        }
    }
    
    stopPhiBreathe() {
        this._stopped = true;
        this._owned = false;
        clearTimeout(this._monthlyTimer);
        for (const timer of this.recoveryTimers || []) clearTimeout(timer);
        this.recoveryTimers?.clear();
        clearTimeout(this._workerRecovery);
        this._workerRecovery = null;
        const worker = this._worker;
        this._worker = null;
        if (worker) {
            this._workerStop = new Promise(resolve => {
                const timeout = setTimeout(() => {
                    logger.warn('Heartbeat worker shutdown timed out; fenced lease will expire');
                    void worker.terminate();
                }, 4500);
                worker.once('exit', () => { clearTimeout(timeout); resolve(); });
                worker.postMessage({ kind: 'stop' });
            });
        }
    }
    
    // ============================================================================
    // DEFERRED STARTUP ORCHESTRATION
    // ============================================================================
    async orchestrateStartup() {
        if (this.initialized || this._stopped) return;
        this.initialized = true;
        logger.info('🌸 Orchestrating deferred startup via phi breathe...');

        this.subscribe('memory-cleanup', PHI_BREATHE.MEMORY_CLEANUP_INTERVAL_MS, async () => {
            if (this.cleanupFunctions.cleanupOldSessions) {
                await this.cleanupFunctions.cleanupOldSessions(PHI_BREATHE.USAGE_CLEANUP_INTERVAL_MS);
            }
        }, { local: true });

        this.subscribe('media-purge', PHI_BREATHE.MEDIA_PURGE_INTERVAL_MS, async () => {
            await this._purgeOldMedia();
        });

        this.subscribe('dormancy-cleanup', PHI_BREATHE.DORMANCY_CLEANUP_INTERVAL_MS, async () => {
            await this._revokeDormantContributors();
        });

        this.subscribe('share-invite-cleanup', PHI_BREATHE.SHARE_INVITE_CLEANUP_INTERVAL_MS, async () => {
            await this._expireStaleShareInvites();
        });

        this.subscribe('pending-book-expiry', PHI_BREATHE.SHARE_INVITE_CLEANUP_INTERVAL_MS, async () => {
            await this._expirePendingBooks();
        });

        this.subscribe('unactivated-book-expiry', PHI_BREATHE.SHARE_INVITE_CLEANUP_INTERVAL_MS, async () => {
            await this._expireUnactivatedBooks();
        });

        this.subscribe('monthly-trigger', PHI_BREATHE.MONTHLY_CLOSING_INTERVAL_MS, () => {
            const now = new Date();
            if (now.getUTCDate() !== 1) return;
            // This trigger itself occupies a maintenance worker. Give its
            // child jobs distinct names and release the worker before they run.
            this._monthlyWork(now).catch(err =>
                logger.error({ err }, '📧 Monthly email: error after closing')
            );
        });

        for (const [name, run] of [
            ['media-purge', () => this._purgeOldMedia()],
            ['dormancy-cleanup', () => this._revokeDormantContributors()],
            ['share-invite-cleanup', () => this._expireStaleShareInvites()],
            ['pending-book-expiry', () => this._expirePendingBooks()],
            ['unactivated-book-expiry', () => this._expireUnactivatedBooks()]
        ]) this._work(name, run, { delayMs: 15000 }).catch(err => logger.error({ err }, 'Deferred startup cleanup failed'));

        logger.info('✅ Phi breathe orchestration complete');
    }
    
    async _purgeOldMedia() {
        let client = null;
        try {
            logger.info('🗑️ Starting 3-day media purge');
            
            client = await this.pool.connect();
            
            const schemas = await client.query(`
                SELECT schema_name 
                FROM information_schema.schemata 
                WHERE schema_name LIKE 'tenant_%'
                ORDER BY schema_name
            `);
            
            let totalPurged = 0;
            
            for (const { schema_name } of schemas.rows) {
                const tableCheck = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = $1 
                        AND table_name = 'media_buffer'
                    ) as exists
                `, [schema_name]);
                
                if (!tableCheck.rows[0].exists) {
                    continue;
                }
                
                // SECURITY: Validate schema name before interpolation
                if (!VALID_SCHEMA_PATTERN.test(schema_name)) {
                    logger.error({ schema: schema_name }, '🔒 Media purge: invalid schema name skipped');
                    continue;
                }
                
                const result = await client.query(`
                    DELETE FROM ${schema_name}.media_buffer 
                    WHERE created_at < NOW() - INTERVAL '3 days'
                    RETURNING id
                `);
                
                if (result.rowCount > 0) {
                    logger.info({ schema: schema_name, purged: result.rowCount }, '🗑️ Media entries purged');
                    totalPurged += result.rowCount;
                }
            }
            
            logger.info({ totalPurged }, '✅ Media purge complete');
        } catch (error) {
            logger.error({ err: error }, '❌ Media purge failed');
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }
    
    async _revokeDormantContributors() {
        try {
            logger.info('🛌 Starting 60-day dormancy cleanup');
            
            const dormantResult = await this.pool.query(`
                WITH registered_phones AS (
                    SELECT DISTINCT ep.phone
                    FROM core.book_engaged_phones ep
                    WHERE ep.is_creator = true
                )
                UPDATE core.book_engaged_phones ep
                SET last_engaged_at = NULL
                WHERE ep.is_creator = false
                  AND ep.last_engaged_at < NOW() - INTERVAL '60 days'
                  AND ep.phone NOT IN (SELECT phone FROM registered_phones)
                RETURNING ep.phone, ep.book_registry_id
            `);
            
            if (dormantResult.rowCount > 0) {
                const revokedPhones = [...new Set(dormantResult.rows.map(r => r.phone))];
                logger.info({ count: dormantResult.rowCount, phones: revokedPhones }, '🚪 Revoked dormant unregistered contributors');
            } else {
                logger.info('✅ No dormant unregistered contributors to revoke');
            }
        } catch (error) {
            logger.error({ err: error }, '❌ Dormancy cleanup failed');
            throw error;
        }
    }
    
    async _expireStaleShareInvites() {
        try {
            logger.info('🔗 Starting 7-day share invite cleanup');
            
            // Find invites older than N days where the invitee hasn't registered
            // Use LOWER() for case-insensitive email matching
            const timeoutDays = MISC.SHARE_INVITE_TIMEOUT_DAYS || 7;
            const expiredResult = await this.pool.query(`
                UPDATE core.book_shares bs
                SET revoked_at = NOW()
                WHERE bs.revoked_at IS NULL
                  AND bs.invited_at < NOW() - INTERVAL '${timeoutDays} days'
                  AND NOT EXISTS (
                      SELECT 1 FROM core.user_email_to_tenant uet
                      WHERE LOWER(uet.email) = LOWER(bs.shared_with_email)
                        AND uet.created_at <= bs.invited_at + (${timeoutDays} * INTERVAL '1 day')
                  )
                RETURNING bs.shared_with_email, bs.book_fractal_id
            `);
            
            if (expiredResult.rowCount > 0) {
                const emails = [...new Set(expiredResult.rows.map(r => r.shared_with_email))];
                logger.info({ count: expiredResult.rowCount, emailPreview: emails.slice(0, 5) }, '⏰ Expired stale share invites');
            } else {
                logger.info('✅ No stale share invites to expire');
            }
        } catch (error) {
            logger.error({ err: error }, '❌ Share invite cleanup failed');
            throw error;
        }
    }
    
    async _expirePendingBooks() {
        try {
            logger.info('📚 Starting 72h unlinked book expiry');

            const expiredResult = await this.pool.query(`
                UPDATE core.book_registry
                SET status = 'expired', updated_at = NOW()
                WHERE status = 'pending'
                  AND created_at < NOW() - INTERVAL '72 hours'
                RETURNING fractal_id, book_name, tenant_email, created_at
            `);

            if (expiredResult.rowCount > 0) {
                const preview = expiredResult.rows.slice(0, 5).map(r => `${r.book_name} (${r.fractal_id})`);
                logger.info({ count: expiredResult.rowCount, preview }, '⏰ Expired pending books (72h timeout, never activated)');
            } else {
                logger.info('✅ No hanging pending books to expire');
            }
        } catch (error) {
            logger.error({ err: error }, '❌ Pending book expiry failed');
        }
    }

    /**
     * Soft-delete tenant-level books that were created but never activated.
     *
     * "Unactivated" ≠ "dormant":
     *   - unactivated: status='inactive' AND archived=false AND no message ever arrived
     *     (never crossed the activation line; packet-queue.js:788 flips status to
     *     'active' on first message)
     *   - dormant:     contributor was active at some point, then went silent
     *     (handled by _revokeDormantContributors at the per-phone level)
     *
     * The registry-level _expirePendingBooks handles handshake-stage rows in
     * core.book_registry. This handles tenant-schema rows in tenant_*.books that
     * survived the handshake but never received traffic. Same 72h threshold for
     * symmetry. Soft-delete (archived=true, status='suspended') matches the
     * DELETE /api/books/:id semantics so the rest of the code's archived=false
     * filters hide them automatically. Constraint-safe: 'suspended' is in the
     * books_status_check allowlist.
     */
    async _expireUnactivatedBooks() {
        let client = null;
        try {
            // Clamp to a safe positive integer — defends against bad config that
            // could otherwise blow up the parameterized interval expression.
            const rawHours = PHI_BREATHE.UNACTIVATED_BOOK_TIMEOUT_HOURS;
            const hours = Number.isInteger(rawHours) && rawHours > 0 ? rawHours : 72;
            logger.info(`🥚 Starting ${hours}h unactivated tenant-book expiry`);

            client = await this.pool.connect();
            const schemas = await client.query(`
                SELECT schema_name
                FROM information_schema.schemata
                WHERE schema_name LIKE 'tenant_%'
                ORDER BY schema_name
            `);

            let totalExpired = 0;
            let schemasFailed = 0;
            const previews = [];

            for (const { schema_name } of schemas.rows) {
                if (!VALID_SCHEMA_PATTERN.test(schema_name)) {
                    logger.error({ schema: schema_name }, '🔒 Unactivated-book expiry: invalid schema name skipped');
                    continue;
                }

                // Per-schema isolation: one bad tenant must not block all the
                // others until the next phi breathe cycle.
                try {
                    const tableCheck = await client.query(`
                        SELECT EXISTS (
                            SELECT FROM information_schema.tables
                            WHERE table_schema = $1 AND table_name = 'books'
                        ) AS exists
                    `, [schema_name]);
                    if (!tableCheck.rows[0].exists) continue;

                    // Defensive check: a book is only considered "unactivated"
                    // if it has ZERO drops (drops are the per-book message ledger
                    // — see routes/books/drops.js). status='inactive' alone could
                    // include books an admin intentionally paused; the NOT EXISTS
                    // gate ensures we only purge books that genuinely never saw
                    // any traffic. Skip schemas without a drops table (older
                    // tenants or partial migrations).
                    const dropsCheck = await client.query(`
                        SELECT EXISTS (
                            SELECT FROM information_schema.tables
                            WHERE table_schema = $1 AND table_name = 'drops'
                        ) AS exists
                    `, [schema_name]);
                    if (!dropsCheck.rows[0].exists) continue;

                    // Parameterized interval (NOW() - $1::int * '1 hour') keeps the
                    // hour count out of the SQL string. Schema name is interpolated
                    // because it's an identifier, gated above by VALID_SCHEMA_PATTERN.
                    const result = await client.query(`
                        UPDATE ${schema_name}.books b
                        SET archived = true, status = 'suspended', updated_at = NOW()
                        WHERE b.status = 'inactive'
                          AND b.archived = false
                          AND b.created_at < NOW() - ($1::int * INTERVAL '1 hour')
                          AND NOT EXISTS (
                              SELECT 1 FROM ${schema_name}.drops d WHERE d.book_id = b.id
                          )
                        RETURNING b.id, b.fractal_id, b.name
                    `, [hours]);

                    if (result.rowCount > 0) {
                        totalExpired += result.rowCount;
                        for (const row of result.rows.slice(0, 3)) {
                            previews.push(`${schema_name}: ${row.name} (${row.fractal_id || row.id})`);
                        }
                    }
                } catch (schemaErr) {
                    schemasFailed += 1;
                    logger.error({
                        schema: schema_name,
                        errMsg: schemaErr.message,
                        errCode: schemaErr.code,
                        errStack: schemaErr.stack
                    }, `❌ Unactivated-book expiry skipped schema ${schema_name}: ${schemaErr.message}`);
                }
            }

            if (totalExpired > 0) {
                logger.info(
                    { count: totalExpired, schemasFailed, preview: previews.slice(0, 5) },
                    `⏰ Expired unactivated tenant books (${hours}h timeout, never messaged)`
                );
            } else {
                logger.info({ schemasFailed }, '✅ No unactivated tenant books to expire');
            }
        } catch (error) {
            logger.error({ errMsg: error.message, errCode: error.code, errStack: error.stack }, '❌ Unactivated-book expiry failed');
            throw error;
        } finally {
            if (client) client.release();
        }
    }
    
    getStatus() {
        const subs = {};
        for (const [name, sub] of this.subscribers) {
            subs[name] = {
                intervalMs: sub.intervalMs,
                lastRun: sub.lastRun ? new Date(sub.lastRun).toISOString() : 'never'
            };
        }
        const nodes = {};
        for (const [name, entry] of this.nodes) {
            nodes[name] = entry;
        }
        return {
            phiBreatheCount: this.phiBreatheCount,
            phiBreatheActive: !!this._worker,
            heartbeatTiming: this.heartbeatTiming,
            subscribers: subs,
            nodes,
            mesh: {
                nodeCount: this.nodes.size,
                nodes,
                events: nyanBus.listEvents()
            }
        };
    }
    
    async shutdown() {
        this.stopPhiBreathe();
        this.initialized = false;
        for (const name of this.intervals.keys()) {
            this.unsubscribe(name);
        }
        logger.info('🛑 Phi breathe shutdown complete');
        await this._workerStop;
    }
}

const phiBreathe = new PhiBreathe();

module.exports = phiBreathe;
