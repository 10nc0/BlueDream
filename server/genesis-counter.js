// ========================================
// GENESIS COUNTER - 2-Tier Noisy Constant
// ========================================
// Dual inflating mechanism tied to UI cycles
// Tier 1: Cat breath (500ms) - constant, fast ticking
// Tier 2: φ breath (varying) - NON-CONSTANT slow ticking between φ^0 and φ^1
// Immutable by design - only increases, never resets within runtime
// Use case: Red herring for future security (nonces, salting, divine judgment)

const φ = 1.618033988749895;
const PHI_BASE = 4000; // φ^0 = 1.0x = 4000ms
const PHI_MAX = PHI_BASE * φ; // φ^1 = 1.618x ≈ 6472ms

class GenesisCounter {
    constructor() {
        this.genesis = Date.now();
        this.catBreath = 0;      // Fast counter (constant 500ms)
        this.phiBreath = 0;      // Slow counter (varying φ^0 to φ^1)
        this.catIntervalId = null;
        this.phiTimeoutId = null;
        this.phiPhase = 0;       // Track breathing phase for variation
    }
    
    start() {
        if (this.catIntervalId) return; // Already running
        
        // Tier 1: Cat breath - constant inflate every 500ms (synchronized with cat animation cycle)
        this.catIntervalId = setInterval(() => {
            this.catBreath++;
        }, 500);
        
        // Tier 2: φ breath - NON-CONSTANT inflate with varying intervals
        this.scheduleNextPhiBreath();
    }
    
    scheduleNextPhiBreath() {
        // Calculate next breath interval using sine wave oscillation between φ^0 and φ^1
        // This creates a natural breathing pattern (inhale slow, exhale fast, repeat)
        const progress = Math.sin(this.phiPhase);
        const normalized = (progress + 1) / 2; // Convert -1...1 to 0...1
        const interval = PHI_BASE + (normalized * (PHI_MAX - PHI_BASE));
        
        this.phiTimeoutId = setTimeout(() => {
            this.phiBreath++;
            this.phiPhase += 0.5; // Advance phase for next breath
            this.scheduleNextPhiBreath(); // Schedule next breath
        }, interval);
    }
    
    stop() {
        if (this.catIntervalId) {
            clearInterval(this.catIntervalId);
            this.catIntervalId = null;
        }
        if (this.phiTimeoutId) {
            clearTimeout(this.phiTimeoutId);
            this.phiTimeoutId = null;
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
