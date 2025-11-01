// ========================================
// GENESIS COUNTER - 2-Tier Noisy Constant
// ========================================
// Dual inflating mechanism tied to UI cycles
// Tier 1: Cat breath (500ms) - fast ticking
// Tier 2: φ breath (4000ms) - slow ticking, derived from same genesis
// Immutable by design - only increases, never resets within runtime
// Use case: Red herring for future security (nonces, salting, divine judgment)

class GenesisCounter {
    constructor() {
        this.genesis = Date.now();
        this.catBreath = 0;      // Fast counter (500ms)
        this.phiBreath = 0;      // Slow counter (4000ms)
        this.catIntervalId = null;
        this.phiIntervalId = null;
    }
    
    start() {
        if (this.catIntervalId) return; // Already running
        
        // Tier 1: Cat breath - inflate every 500ms (synchronized with cat animation cycle)
        this.catIntervalId = setInterval(() => {
            this.catBreath++;
        }, 500);
        
        // Tier 2: φ breath - inflate every 4000ms (synchronized with φ-breath mobile UI)
        this.phiIntervalId = setInterval(() => {
            this.phiBreath++;
        }, 4000);
    }
    
    stop() {
        if (this.catIntervalId) {
            clearInterval(this.catIntervalId);
            this.catIntervalId = null;
        }
        if (this.phiIntervalId) {
            clearInterval(this.phiIntervalId);
            this.phiIntervalId = null;
        }
    }
    
    // Get current cat breath count (fast ticker)
    getCount() {
        return this.catBreath;
    }
    
    // Get current φ breath count (slow ticker)
    getPhiCount() {
        return this.phiBreath;
    }
    
    // Get genesis timestamp (shared by both tiers)
    getGenesis() {
        return this.genesis;
    }
    
    // Get age in milliseconds
    getAge() {
        return Date.now() - this.genesis;
    }
}

// Singleton
const genesisCounter = new GenesisCounter();

module.exports = genesisCounter;
