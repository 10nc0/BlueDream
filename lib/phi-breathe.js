'use strict';

const { PHI_BREATHE, MISC } = require('../config/constants');
const logger = require('./logger');
const { VALID_SCHEMA_PATTERN } = require('./validators');
const { runMonthlyClosing } = require('./monthly-closing');
const { runMonthlyEmail } = require('./monthly-email');
const nyanBus = require('./nyan-bus');

const PHI = PHI_BREATHE.PHI;
const BASE_BREATH = PHI_BREATHE.BASE_INTERVAL_MS;

class PhiBreathe {
    constructor() {
        this.subscribers = new Map();
        this.intervals = new Map();
        this.phiBreatheCount = 0;
        this.phiBreatheTimer = null;
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

    subscribe(name, intervalMs, callback) {
        if (this.subscribers.has(name)) {
            logger.warn({ subscriber: name }, '⚡ Phi breathe: subscriber already registered, replacing');
            this.unsubscribe(name);
        }
        
        this.subscribers.set(name, { intervalMs, callback, lastRun: 0, failures: 0 });
        
        const timer = setInterval(async () => {
            const sub = this.subscribers.get(name);
            if (!sub) return;
            
            if (sub.failures >= 3) {
                logger.warn({ subscriber: name, failures: sub.failures }, '⚡ Circuit breaker: auto-unsubscribing after consecutive failures');
                this.unsubscribe(name);
                // Schedule one recovery attempt after 5-minute cooldown
                const COOLDOWN_MS = 5 * 60 * 1000;
                setTimeout(() => {
                    logger.info({ subscriber: name }, '⚡ Circuit breaker: cooldown elapsed — attempting re-registration');
                    this.subscribe(name, intervalMs, callback);
                }, COOLDOWN_MS);
                return;
            }
            
            try {
                await callback();
                sub.lastRun = Date.now();
                sub.failures = 0;
            } catch (error) {
                sub.failures++;
                logger.error({ subscriber: name, failures: sub.failures, err: error }, 'Phi breathe subscriber error');
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
        if (this.phiBreatheTimer || this._lockRecoveryTimer) return;

        const isProd = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
        this.isProduction = isProd;

        if (!isProd) {
            this.phiBreatheCount = 0;
            logger.info('🌱 Dev mode: phi breathe starts from #1 (local, resets on restart)');
            this._devPhiBreathe();
            return;
        }

        // LEADER ELECTION (prod only): pg_try_advisory_lock is session-scoped —
        // auto-releases when the connection closes (process dies), no TTL needed.
        // Magic key: 0x4E59414E = "NYAN" in ASCII.
        // Fast-retry loop: covers typical SIGTERM → connection close timing (~5-8s).
        if (this.pool) {
            const MAX_LOCK_RETRIES = 5;
            const LOCK_RETRY_DELAY_MS = 2000;
            const acquired = await this._tryAcquireLock(MAX_LOCK_RETRIES, LOCK_RETRY_DELAY_MS);

            if (!acquired) {
                logger.warn('⚠️ Phi breathe: initial lock acquisition failed after %ds — entering background recovery', MAX_LOCK_RETRIES * LOCK_RETRY_DELAY_MS / 1000);
                this._startLockRecovery();
                return;
            }
        }

        await this._onLockAcquired();
    }

    async _tryAcquireLock(maxRetries, delayMs) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let queryOk = false;
            try {
                const lockRes = await this.pool.query('SELECT pg_try_advisory_lock(1314212174)');
                queryOk = true;
                if (lockRes.rows[0].pg_try_advisory_lock) {
                    return true;
                }
            } catch (err) {
                logger.error({ err, attempt }, 'Phi breathe: lock query failed (DB error, not contention)');
            }
            if (attempt < maxRetries) {
                const reason = queryOk ? 'lock held by another instance' : 'DB query error';
                logger.warn({ attempt, maxRetries, reason }, '💤 Phi breathe: %s, retrying in %dms…', reason, delayMs);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
        return false;
    }

    _startLockRecovery() {
        const RECOVERY_INTERVAL_MS = 10000;
        const HARD_CEILING_MS = 120000;
        const startedAt = Date.now();

        const tick = async () => {
            const elapsed = Date.now() - startedAt;
            if (elapsed >= HARD_CEILING_MS) {
                this._lockRecoveryTimer = null;
                logger.error('❌ Phi breathe: gave up leader lock recovery after %ds — instance running without heartbeat', Math.round(elapsed / 1000));
                return;
            }

            try {
                const lockRes = await this.pool.query('SELECT pg_try_advisory_lock(1314212174)');
                if (lockRes.rows[0].pg_try_advisory_lock) {
                    this._lockRecoveryTimer = null;
                    logger.info({ elapsedMs: elapsed }, '🫀 Phi breathe: acquired leader lock on recovery — resuming heartbeat');
                    await this._onLockAcquired();
                    return;
                }
                logger.warn({ elapsedMs: elapsed }, '💤 Phi breathe: lock still held, recovery retry…');
            } catch (err) {
                logger.error({ err }, 'Phi breathe: recovery lock query failed');
            }

            this._lockRecoveryTimer = setTimeout(tick, RECOVERY_INTERVAL_MS);
        };

        this._lockRecoveryTimer = setTimeout(tick, RECOVERY_INTERVAL_MS);
    }

    async _onLockAcquired() {
        logger.info('🫀 Phi breathe: acquired leader lock — this instance is the heartbeat');

        if (this.pool) {
            try {
                const res = await this.pool.query(
                    `SELECT value FROM core.system_counters WHERE key = 'phi_breathe_count'`
                );
                if (res.rows[0]) {
                    logger.info({ count: res.rows[0].value }, '♾️ Genesis restored: phi breathe eternal count');
                }
            } catch (err) {
                logger.warn({ err }, '⚠️ Phi counter table not ready yet, will initialize on first breath');
            }
        }

        this._atomicPhiBreathe();
    }
    
    async _atomicPhiBreathe() {
        try {
            const res = await this.pool.query(
                `INSERT INTO core.system_counters (key, value) 
                 VALUES ('phi_breathe_count', 1)
                 ON CONFLICT (key) DO UPDATE 
                 SET value = core.system_counters.value + 1, updated_at = NOW()
                 RETURNING value`
            );
            
            this.phiBreatheCount = parseInt(res.rows[0].value, 10);
            const isInhale = this.phiBreatheCount % 2 === 1;
            const duration = isInhale ? Math.round(BASE_BREATH * PHI) : BASE_BREATH;
            const type = isInhale ? 'inhale' : 'exhale';
            const multiplier = isInhale ? ' (φ×1.618)' : '';

            logger.info({ count: this.phiBreatheCount, type, durationMs: duration }, `🌬️ phi breathe #${this.phiBreatheCount} ${type} ${duration}ms${multiplier}`);

            // Heartbeat checkpoint every 86 breaths (~15min)
            if (this.phiBreatheCount % 86 === 0) {
                if (this.heartbeatCallback) {
                    this.heartbeatCallback(this.phiBreatheCount);
                }
                this._snapshotNodeRegistry();
            }

            this.phiBreatheTimer = setTimeout(() => this._atomicPhiBreathe(), duration);
        } catch (error) {
            logger.error({ err: error }, 'Phi breathe DB error');
            this.phiBreatheTimer = setTimeout(() => this._atomicPhiBreathe(), BASE_BREATH);
        }
    }
    
    _devPhiBreathe() {
        this.phiBreatheCount++;
        const isInhale = this.phiBreatheCount % 2 === 1;
        const duration = isInhale ? Math.round(BASE_BREATH * PHI) : BASE_BREATH;
        const type = isInhale ? 'inhale' : 'exhale';
        const multiplier = isInhale ? ' (φ×1.618)' : '';

        logger.info({ count: this.phiBreatheCount, type, durationMs: duration, mode: 'dev' }, `🌬️ phi breathe #${this.phiBreatheCount} ${type} ${duration}ms${multiplier}`);

        // Heartbeat checkpoint every 86 breaths (~15min)
        if (this.phiBreatheCount % 86 === 0) {
            if (this.heartbeatCallback) {
                this.heartbeatCallback(this.phiBreatheCount);
            }
            this._snapshotNodeRegistry();
        }

        this.phiBreatheTimer = setTimeout(() => this._devPhiBreathe(), duration);
    }
    
    stopPhiBreathe() {
        if (this.phiBreatheTimer) {
            clearTimeout(this.phiBreatheTimer);
            this.phiBreatheTimer = null;
        }
        if (this._lockRecoveryTimer) {
            clearTimeout(this._lockRecoveryTimer);
            this._lockRecoveryTimer = null;
        }
    }
    
    // ============================================================================
    // DEFERRED STARTUP ORCHESTRATION
    // ============================================================================
    async orchestrateStartup() {
        logger.info('🌸 Orchestrating deferred startup via phi breathe...');

        this.subscribe('memory-cleanup', PHI_BREATHE.MEMORY_CLEANUP_INTERVAL_MS, async () => {
            if (this.cleanupFunctions.cleanupOldSessions) {
                await this.cleanupFunctions.cleanupOldSessions(PHI_BREATHE.USAGE_CLEANUP_INTERVAL_MS);
            }
        });

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

        this.subscribe('monthly-closing', PHI_BREATHE.MONTHLY_CLOSING_INTERVAL_MS, async () => {
            const now = new Date();
            if (now.getUTCDate() !== 1) return;
            await runMonthlyClosing(this.pool, this.bots);
            await runMonthlyEmail(this.pool).catch(err =>
                logger.error({ err }, '📧 Monthly email: error after closing')
            );
        });

        Promise.all([
            this._purgeOldMedia(),
            this._revokeDormantContributors(),
            this._expireStaleShareInvites(),
            this._expirePendingBooks(),
        ]).catch(err => logger.error({ err }, 'Startup cleanup batch error'));

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
            phiBreatheActive: !!this.phiBreatheTimer,
            subscribers: subs,
            nodes,
            mesh: {
                nodeCount: this.nodes.size,
                nodes,
                events: nyanBus.listEvents()
            }
        };
    }
    
    shutdown() {
        this.stopPhiBreathe();
        for (const name of this.intervals.keys()) {
            this.unsubscribe(name);
        }
        logger.info('🛑 Phi breathe shutdown complete');
    }
}

const phiBreathe = new PhiBreathe();

module.exports = phiBreathe;
