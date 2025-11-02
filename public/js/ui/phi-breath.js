/**
 * φ-BREATH v2.0 — IDLE FIRST
 * "The button awakens from silence"
 * 
 * State Machine:
 * IDLE (default, φ=1.0) ↔ FAST (on activity, φ=1.618)
 * + Independent EVENT triggers (jump, new message)
 */

const PHI_BREATH = (function() {
    'use strict';
    
    // Golden Ratio Constants
    const φ = 1.618033988749895;
    const BASE_DURATION = 4000; // 4s cycle duration
    
    // State
    let isIdle = true;
    let currentScale = 1.0;
    let targetScale = 1.0;
    let animationFrameId = null;
    let idleTimer = null;
    
    // Rotation (independent, always spinning)
    let rotationDegrees = 0;
    let rotationStartTime = 0;
    
    /**
     * Initialize - Start IDLE (φ = 1.0)
     */
    function init() {
        console.log('🫁 φ-Breath System v2.0 initialized');
        console.log('   State: IDLE (default)');
        console.log('   φ⁰ (Idle): 1.0');
        console.log('   φ¹ (Fast): 1.618');
        console.log('   "The button awakens from silence."');
        
        rotationStartTime = performance.now();
        startIdle();
        startRotationLoop();
    }
    
    /**
     * Start IDLE state (φ = 1.0)
     */
    function startIdle() {
        isIdle = true;
        targetScale = 1.0;
        animateTo(targetScale, 2000); // 2s smooth return to idle
    }
    
    /**
     * Go FAST (φ = 1.618) - triggered by activity
     */
    function goFast() {
        if (isIdle) {
            isIdle = false;
            targetScale = 1.618;
            animateTo(targetScale, 600); // 600ms quick expansion
            console.log('⚡ FAST mode activated (φ=1.618)');
        }
        
        // Reset idle timer - return to idle after 5s inactivity
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            goIdle();
        }, 5000);
    }
    
    /**
     * Return to IDLE (φ = 1.0)
     */
    function goIdle() {
        if (!isIdle) {
            isIdle = true;
            targetScale = 1.0;
            animateTo(targetScale, 2000); // 2s smooth contraction
            console.log('😌 IDLE mode - returning to rest (φ=1.0)');
        }
    }
    
    /**
     * Animate to target scale with easing
     */
    function animateTo(target, duration) {
        const start = performance.now();
        const initial = currentScale;
        
        const tick = (now) => {
            const progress = Math.min((now - start) / duration, 1);
            
            // easeInOutQuad
            const ease = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            
            currentScale = initial + (target - initial) * ease;
            updateCSS();
            
            if (progress < 1) {
                animationFrameId = requestAnimationFrame(tick);
            } else {
                currentScale = target;
                updateCSS();
            }
        };
        
        requestAnimationFrame(tick);
    }
    
    /**
     * Rotation loop (independent, always running)
     */
    function startRotationLoop() {
        function tick(now) {
            const elapsed = now - rotationStartTime;
            rotationDegrees = (elapsed / 20000) * 360; // 20s per rotation
            
            document.documentElement.style.setProperty('--radiant-deg', `${rotationDegrees % 360}deg`);
            document.documentElement.style.setProperty('--radiant-progress', (rotationDegrees % 360) / 360);
            
            requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }
    
    /**
     * Update CSS variables
     */
    function updateCSS() {
        const scale = currentScale.toFixed(4);
        const progress = ((currentScale - 1.0) / 0.618).toFixed(4);
        
        document.documentElement.style.setProperty('--φ-scale', scale);
        document.documentElement.style.setProperty('--φ-progress', progress);
    }
    
    /**
     * Event Triggers
     */
    function onMessage() {
        goFast();
        // Auto-return to IDLE after message event (2s burst)
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => goIdle(), 2000);
    }
    
    function onUserActivity() {
        goFast();
        // Auto-return to IDLE after user activity stops (3s)
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => goIdle(), 3000);
    }
    
    function onJump() {
        // Jump: Quick FAST burst, then return to IDLE
        goFast();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            goIdle();
            console.log('🎯 Jump complete - returned to IDLE');
        }, 1500); // 1.5s burst
    }
    
    function onNewMessage() {
        // New message glow: Quick FAST burst, then return to IDLE
        goFast();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            goIdle();
            console.log('✨ Glow complete - returned to IDLE');
        }, 2000); // 2s burst
    }
    
    /**
     * Stop animations (cleanup)
     */
    function stop() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        clearTimeout(idleTimer);
        console.log('🫁 φ-Breath System stopped');
    }
    
    /**
     * Get current state
     */
    function getState() {
        return {
            isIdle,
            currentScale,
            targetScale,
            rotationDegrees: rotationDegrees % 360
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
        BASE_DURATION,
        
        // Getters
        get isIdle() { return isIdle; },
        get currentScale() { return currentScale; }
    };
})();

// Auto-initialize if not in module context
if (typeof module === 'undefined') {
    console.log('🫁 φ-Breath module loaded');
}
