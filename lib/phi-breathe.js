'use strict';

const PHI = 1.618033988749895;
const BASE_BREATH = 4000;

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
        this.isProduction = process.env.NODE_ENV === 'production';
        this.initialized = false;
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
    
    subscribe(name, intervalMs, callback) {
        if (this.subscribers.has(name)) {
            console.log(`⚠️ Phi breathe: ${name} already subscribed, replacing`);
            this.unsubscribe(name);
        }
        
        this.subscribers.set(name, { intervalMs, callback, lastRun: 0, failures: 0 });
        
        const timer = setInterval(async () => {
            const sub = this.subscribers.get(name);
            if (!sub) return;
            
            if (sub.failures >= 3) {
                console.warn(`🔌 Circuit breaker: auto-unsubscribing ${name} after ${sub.failures} consecutive failures`);
                this.unsubscribe(name);
                return;
            }
            
            try {
                await callback();
                sub.lastRun = Date.now();
                sub.failures = 0;
            } catch (error) {
                sub.failures++;
                console.error(`❌ Phi breathe ${name} error (${sub.failures}/3):`, error.message);
            }
        }, intervalMs);
        
        this.intervals.set(name, timer);
        console.log(`💓 Phi breathe: ${name} subscribed (${Math.round(intervalMs / 1000 / 60)}min cycle)`);
    }
    
    unsubscribe(name) {
        const timer = this.intervals.get(name);
        if (timer) {
            clearInterval(timer);
            this.intervals.delete(name);
            this.subscribers.delete(name);
            console.log(`💔 Phi breathe: ${name} unsubscribed`);
        }
    }
    
    // ============================================================================
    // PHI BREATHE RHYTHM: Modular orchestrator
    // ============================================================================
    async startPhiBreathe() {
        if (this.phiBreatheTimer) return;
        
        if (this.isProduction && this.pool) {
            try {
                const res = await this.pool.query(
                    `SELECT value FROM core.system_counters WHERE key = 'phi_breathe_count'`
                );
                if (res.rows[0]) {
                    console.log(`✨ Genesis restored: phi breathe #${res.rows[0].value} (eternal count since genesis)`);
                }
            } catch (err) {
                console.log('⚠️ Phi counter table not ready yet, will initialize on first breath');
            }
            
            this._atomicPhiBreathe();
        } else {
            console.log(`🔄 Dev mode: phi breathe starts fresh (in-memory, resets on refresh)`);
            this._devPhiBreathe();
        }
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
            const multiplier = isInhale ? '(φ×1.618)' : '';
            
            console.log(`🌬️  phi breathe #${this.phiBreatheCount} ${type} ${duration}ms ${multiplier}`);
            
            // Heartbeat checkpoint every 86 breaths (~15min)
            if (this.phiBreatheCount % 86 === 0 && this.heartbeatCallback) {
                this.heartbeatCallback(this.phiBreatheCount);
            }
            
            this.phiBreatheTimer = setTimeout(() => this._atomicPhiBreathe(), duration);
        } catch (error) {
            console.error('❌ Phi breathe DB error:', error.message);
            this.phiBreatheTimer = setTimeout(() => this._atomicPhiBreathe(), BASE_BREATH);
        }
    }
    
    _devPhiBreathe() {
        this.phiBreatheCount++;
        const isInhale = this.phiBreatheCount % 2 === 1;
        const duration = isInhale ? Math.round(BASE_BREATH * PHI) : BASE_BREATH;
        const type = isInhale ? 'inhale' : 'exhale';
        const multiplier = isInhale ? '(φ×1.618)' : '';
        
        console.log(`🌬️  phi breathe #${this.phiBreatheCount} ${type} ${duration}ms ${multiplier} (dev mode)`);
        
        // Heartbeat checkpoint every 86 breaths (~15min)
        if (this.phiBreatheCount % 86 === 0 && this.heartbeatCallback) {
            this.heartbeatCallback(this.phiBreatheCount);
        }
        
        this.phiBreatheTimer = setTimeout(() => this._devPhiBreathe(), duration);
    }
    
    stopPhiBreathe() {
        if (this.phiBreatheTimer) {
            clearTimeout(this.phiBreatheTimer);
            this.phiBreatheTimer = null;
        }
    }
    
    // ============================================================================
    // DEFERRED STARTUP ORCHESTRATION
    // ============================================================================
    async orchestrateStartup() {
        console.log('🔄 Orchestrating deferred startup via phi breathe...');
        
        // 1. MEMORY CLEANUP: 15min cycle (1h max age)
        this.subscribe('memory-cleanup', 15 * 60 * 1000, async () => {
            if (this.cleanupFunctions.cleanupOldSessions) {
                await this.cleanupFunctions.cleanupOldSessions(60 * 60 * 1000);
            }
        });
        
        // 2. MEDIA PURGE: Immediate + 24h cycle
        await this._purgeOldMedia();
        this.subscribe('media-purge', 24 * 60 * 60 * 1000, async () => {
            await this._purgeOldMedia();
        });
        
        // 3. DORMANCY CLEANUP: Immediate + 24h cycle
        await this._revokeDormantContributors();
        this.subscribe('dormancy-cleanup', 24 * 60 * 60 * 1000, async () => {
            await this._revokeDormantContributors();
        });
        
        console.log('✅ Phi breathe orchestration complete');
    }
    
    async _purgeOldMedia() {
        let client = null;
        try {
            console.log('🧹 Phi breathe: Starting 3-day media purge...');
            
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
                
                const result = await client.query(`
                    DELETE FROM ${schema_name}.media_buffer 
                    WHERE created_at < NOW() - INTERVAL '3 days'
                    RETURNING id
                `);
                
                if (result.rowCount > 0) {
                    console.log(`  🗑️  Purged ${result.rowCount} media entries from ${schema_name}`);
                    totalPurged += result.rowCount;
                }
            }
            
            console.log(`✅ Media purge complete: ${totalPurged} total entries removed`);
        } catch (error) {
            console.error('❌ Media purge failed:', error.message);
        } finally {
            if (client) {
                client.release();
            }
        }
    }
    
    async _revokeDormantContributors() {
        try {
            console.log('🔒 Phi breathe: Starting 60-day dormancy cleanup...');
            
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
                console.log(`🔒 Revoked access for ${dormantResult.rowCount} dormant unregistered contributors`);
                
                if (this.bots.idris && this.bots.idris.ready) {
                    const revokedPhones = [...new Set(dormantResult.rows.map(r => r.phone))];
                    console.log(`   Revoked phones: ${revokedPhones.join(', ')}`);
                }
            } else {
                console.log('✅ No dormant unregistered contributors to revoke');
            }
        } catch (error) {
            console.error('❌ Dormancy cleanup failed:', error.message);
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
        return {
            phiBreatheCount: this.phiBreatheCount,
            phiBreatheActive: !!this.phiBreatheTimer,
            subscribers: subs
        };
    }
    
    shutdown() {
        this.stopPhiBreathe();
        for (const name of this.intervals.keys()) {
            this.unsubscribe(name);
        }
        console.log('💀 Phi breathe shutdown complete');
    }
}

const phiBreathe = new PhiBreathe();

module.exports = phiBreathe;
