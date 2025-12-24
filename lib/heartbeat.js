'use strict';

const PHI = 1.618033988749895;
const BASE_BREATH = 4000;

class Heartbeat {
    constructor() {
        this.subscribers = new Map();
        this.intervals = new Map();
        this.phiBreatheCount = 0;
        this.phiBreatheTimer = null;
        this.pool = null;
        this.isProduction = process.env.NODE_ENV === 'production';
        this.initialized = false;
    }
    
    setPool(pool) {
        this.pool = pool;
    }
    
    subscribe(name, intervalMs, callback) {
        if (this.subscribers.has(name)) {
            console.log(`⚠️ Heartbeat: ${name} already subscribed, replacing`);
            this.unsubscribe(name);
        }
        
        this.subscribers.set(name, { intervalMs, callback, lastRun: 0 });
        
        const timer = setInterval(async () => {
            try {
                await callback();
                this.subscribers.get(name).lastRun = Date.now();
            } catch (error) {
                console.error(`❌ Heartbeat ${name} error:`, error.message);
            }
        }, intervalMs);
        
        this.intervals.set(name, timer);
        console.log(`💓 Heartbeat: ${name} subscribed (${Math.round(intervalMs / 1000 / 60)}min cycle)`);
    }
    
    unsubscribe(name) {
        const timer = this.intervals.get(name);
        if (timer) {
            clearInterval(timer);
            this.intervals.delete(name);
            this.subscribers.delete(name);
            console.log(`💔 Heartbeat: ${name} unsubscribed`);
        }
    }
    
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
            const duration = isInhale ? BASE_BREATH : Math.round(BASE_BREATH * PHI);
            const type = isInhale ? 'inhale' : 'exhale';
            const multiplier = isInhale ? '' : '(φ×1.618)';
            
            console.log(`🌬️  phi breathe #${this.phiBreatheCount} ${type} ${duration}ms ${multiplier}`);
            
            this.phiBreatheTimer = setTimeout(() => this._atomicPhiBreathe(), duration);
        } catch (error) {
            console.error('❌ Phi breathe DB error:', error.message);
            this.phiBreatheTimer = setTimeout(() => this._atomicPhiBreathe(), BASE_BREATH);
        }
    }
    
    _devPhiBreathe() {
        this.phiBreatheCount++;
        const isInhale = this.phiBreatheCount % 2 === 1;
        const duration = isInhale ? BASE_BREATH : Math.round(BASE_BREATH * PHI);
        const type = isInhale ? 'inhale' : 'exhale';
        const multiplier = isInhale ? '' : '(φ×1.618)';
        
        console.log(`🌬️  phi breathe #${this.phiBreatheCount} ${type} ${duration}ms ${multiplier} (dev mode)`);
        
        this.phiBreatheTimer = setTimeout(() => this._devPhiBreathe(), duration);
    }
    
    stopPhiBreathe() {
        if (this.phiBreatheTimer) {
            clearTimeout(this.phiBreatheTimer);
            this.phiBreatheTimer = null;
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
        console.log('💀 Heartbeat shutdown complete');
    }
}

const heartbeat = new Heartbeat();

module.exports = heartbeat;
