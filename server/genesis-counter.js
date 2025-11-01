// ========================================
// GENESIS COUNTER - Noisy Constant
// ========================================
// Simple inflating mechanism tied to UI cycle (500ms cat breath)
// Immutable by design - only increases, never resets within runtime
// Use case: Red herring for future security (nonces, salting, divine judgment)

class GenesisCounter {
    constructor() {
        this.genesis = Date.now();
        this.count = 0;
        this.intervalId = null;
    }
    
    start() {
        if (this.intervalId) return;
        
        // Inflate every 500ms (synchronized with cat animation cycle)
        this.intervalId = setInterval(() => {
            this.count++;
        }, 500);
    }
    
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
    
    // Get current count (immutable - read-only)
    getCount() {
        return this.count;
    }
    
    // Get genesis timestamp
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
