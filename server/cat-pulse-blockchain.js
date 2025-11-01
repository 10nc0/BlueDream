// ========================================
// CAT PULSE BLOCKCHAIN
// ========================================
// Universal root timestamp system synchronized with the cat animation
// Each "block" represents one cat breath cycle (~500ms)
// Provides immutable, incrementing reference like blockchain block height

const CAT_PULSE_CONFIG = Object.freeze({
    CYCLE_DURATION: 500, // ms - matches cat JUMP_FRAME_INTERVAL (15 frames @ 60fps)
    LOG_INTERVAL: 100,   // Log every 100 blocks (~50 seconds)
    ENABLE_LOGGING: true // Set to false to disable console logging
});

class CatPulseBlockchain {
    constructor() {
        this.currentBlock = 0;
        this.genesisTime = Date.now();
        this.lastPulseTime = this.genesisTime;
        this.isRunning = false;
        this.intervalId = null;
        
        console.log('🐱⛓️  CAT PULSE BLOCKCHAIN initialized');
        console.log(`   Genesis Time: ${new Date(this.genesisTime).toISOString()}`);
        console.log(`   Pulse Cycle: ${CAT_PULSE_CONFIG.CYCLE_DURATION}ms`);
        console.log(`   Block 0 mined at ${new Date(this.genesisTime).toISOString()}`);
    }
    
    start() {
        if (this.isRunning) {
            console.warn('⚠️ Cat Pulse Blockchain already running');
            return;
        }
        
        this.isRunning = true;
        this.lastPulseTime = Date.now();
        
        this.intervalId = setInterval(() => {
            this.pulse();
        }, CAT_PULSE_CONFIG.CYCLE_DURATION);
        
        console.log('🐱⛓️  Cat Pulse Blockchain started - mining blocks every 500ms');
    }
    
    pulse() {
        this.currentBlock++;
        const now = Date.now();
        const uptime = now - this.genesisTime;
        
        // Log every N blocks to avoid console spam
        if (CAT_PULSE_CONFIG.ENABLE_LOGGING && this.currentBlock % CAT_PULSE_CONFIG.LOG_INTERVAL === 0) {
            console.log(`🐱⛓️  Block #${this.currentBlock} | Uptime: ${this.formatUptime(uptime)} | ${new Date(now).toISOString()}`);
        }
        
        this.lastPulseTime = now;
    }
    
    stop() {
        if (!this.isRunning) {
            return;
        }
        
        clearInterval(this.intervalId);
        this.isRunning = false;
        console.log(`🐱⛓️  Cat Pulse Blockchain stopped at Block #${this.currentBlock}`);
    }
    
    getBlockHeight() {
        return this.currentBlock;
    }
    
    getGenesisTime() {
        return this.genesisTime;
    }
    
    getUptime() {
        return Date.now() - this.genesisTime;
    }
    
    getBlockInfo() {
        return {
            blockHeight: this.currentBlock,
            genesisTime: this.genesisTime,
            lastPulseTime: this.lastPulseTime,
            uptime: this.getUptime(),
            cycleMs: CAT_PULSE_CONFIG.CYCLE_DURATION,
            isRunning: this.isRunning
        };
    }
    
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) {
            return `${days}d ${hours % 24}h ${minutes % 60}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }
}

// Singleton instance
const catPulseBlockchain = new CatPulseBlockchain();

module.exports = catPulseBlockchain;
