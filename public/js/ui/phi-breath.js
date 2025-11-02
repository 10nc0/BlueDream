/**
 * φ-BREATH v2.1 — CONTINUOUS BREATHING
 * "Spin, glow, and breathe as one"
 * 
 * Breathing Modes:
 * IDLE (slow breathing) ↔ FAST (fast breathing)
 * Breathing never stops, only speed changes
 */

const PHI_BREATH = (function() {
    'use strict';
    
    // Golden Ratio Constants
    const φ = 1.618033988749895;
    const IDLE_DURATION = 4000; // 4s breathing cycle when idle (slow)
    const FAST_DURATION = 1618; // 1.618s breathing cycle when fast
    
    // State
    let isIdle = true;
    let currentBreathDuration = IDLE_DURATION;
    let idleTimer = null;
    
    // Unified clock (rotation + breathing + glow)
    let clockStartTime = 0;
    
    /**
     * Initialize - Start continuous breathing at IDLE speed
     */
    function init() {
        console.log('🫁 φ-Breath System v2.1 initialized');
        console.log('   Breathing: CONTINUOUS (never stops)');
        console.log('   IDLE speed: 4.0s cycle (slow, gentle)');
        console.log('   FAST speed: 1.618s cycle (quick, energized)');
        console.log('   "Spin, glow, and breathe as one."');
        
        clockStartTime = performance.now();
        startUnifiedClock();
    }
    
    /**
     * Go FAST - speed up breathing cycle (for button expansion, user activity)
     */
    function goFast(duration = 5000) {
        if (isIdle) {
            isIdle = false;
            currentBreathDuration = FAST_DURATION;
            console.log('⚡ FAST mode activated (φ=1.618)');
        }
        
        // Reset idle timer - return to slow breathing after specified duration
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            goIdle();
        }, duration);
    }
    
    /**
     * Return to IDLE - slow down breathing cycle
     */
    function goIdle() {
        if (!isIdle) {
            isIdle = true;
            currentBreathDuration = IDLE_DURATION;
            console.log('😌 IDLE mode - returning to rest (φ=1.0)');
        }
    }
    
    /**
     * Unified clock - updates rotation, glow, AND breathing together
     */
    function startUnifiedClock() {
        function tick(now) {
            const elapsed = now - clockStartTime;
            
            // 1. ROTATION (20s per full rotation - constant speed)
            const rotationDegrees = (elapsed / 20000) * 360;
            const rotationNormalized = (rotationDegrees % 360) / 360;
            
            // 2. BREATHING (oscillates 1.0 → 1.618 → 1.0 at current speed)
            const breathProgress = (elapsed % currentBreathDuration) / currentBreathDuration;
            const breathSine = Math.sin(breathProgress * Math.PI * 2); // -1 to 1
            const breathScale = 1.0 + (0.618 * 0.5) * (breathSine + 1); // 1.0 to 1.618
            
            // 3. GLOW PROGRESS (follows rotation)
            const glowProgress = rotationNormalized;
            
            // Update all CSS variables in one frame (synchronized)
            document.documentElement.style.setProperty('--radiant-deg', `${rotationDegrees % 360}deg`);
            document.documentElement.style.setProperty('--radiant-progress', glowProgress.toFixed(4));
            document.documentElement.style.setProperty('--φ-scale', breathScale.toFixed(4));
            
            requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }
    
    /**
     * Event Triggers - speed up breathing for exactly 1 φ-breath cycle, then return to IDLE
     */
    function onMessage() {
        goFast();
        // Auto-return to IDLE after 1 complete φ-breath cycle at FAST speed
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => goIdle(), FAST_DURATION);
    }
    
    function onUserActivity() {
        goFast();
        // Auto-return to IDLE after 1 complete φ-breath cycle at FAST speed
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => goIdle(), FAST_DURATION);
    }
    
    function onJump() {
        // Jump: 1 φ-breath cycle at FAST speed, then return to IDLE
        goFast();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            goIdle();
            console.log('🎯 Jump complete - returned to IDLE after 1 φ-breath');
        }, FAST_DURATION); // 1.618s = 1 complete breath cycle
    }
    
    function onNewMessage() {
        // New message: 1 φ-breath cycle at FAST speed, then return to IDLE
        goFast();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            goIdle();
            console.log('✨ New message - returned to IDLE after 1 φ-breath');
        }, FAST_DURATION); // 1.618s = 1 complete breath cycle
    }
    
    /**
     * Stop animations (cleanup)
     */
    function stop() {
        clearTimeout(idleTimer);
        console.log('🫁 φ-Breath System stopped');
    }
    
    /**
     * Get current state
     */
    function getState() {
        const elapsed = performance.now() - clockStartTime;
        const breathProgress = (elapsed % currentBreathDuration) / currentBreathDuration;
        
        return {
            isIdle,
            currentBreathDuration,
            breathProgress,
            elapsed
        };
    }
    
    // Public API
    return {
        init,
        goFast,
        goIdle,
        onMessage,
        onUserActivity,
        onJump,
        onNewMessage,
        getState,
        stop,
        
        // Constants
        φ,
        IDLE_DURATION,
        FAST_DURATION,
        
        // Getters
        get isIdle() { return isIdle; },
        get currentBreathDuration() { return currentBreathDuration; }
    };
})();

// Auto-initialize if not in module context
if (typeof module === 'undefined') {
    console.log('🫁 φ-Breath module loaded');
}
