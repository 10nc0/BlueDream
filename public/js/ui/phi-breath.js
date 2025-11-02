/**
 * φ-BREATH SYSTEM — Centralized Golden Ratio Breathing
 * 
 * The universal breath that pulses through all animations.
 * Like a cat's heartbeat, all related animations sync to this constant.
 * 
 * Breath Cycle: φ^0 (1.0x) → φ^1 (1.618x) full inhale-exhale
 * Duration: 4000ms base (can be scaled)
 * 
 * This module:
 * - Manages the constant breathing cycle
 * - Logs each breath (like a heartbeat monitor)
 * - Provides events for animations to sync with
 * - Centralizes time so all animations breathe together
 */

const PHI_BREATH = (function() {
    'use strict';
    
    // Golden Ratio Constants
    const φ = 1.618033988749895;
    const BASE_DURATION = 4000; // 4s base cycle
    
    // Breathing State
    let breathCount = 0;
    let currentPhase = 'idle'; // 'idle', 'inhale', 'exhale', 'creation'
    let breathStartTime = 0;
    let animationFrameId = null;
    let currentCycleDuration = BASE_DURATION;
    let lastBreathTimestamp = 0; // Guard to prevent multiple breath events
    
    // Event Listeners
    const listeners = {
        breathStart: [],
        breathCycle: [],
        phaseChange: [],
        creation: []
    };
    
    // Breath Log (last 10 breaths for monitoring)
    const breathLog = [];
    const MAX_LOG_SIZE = 10;
    
    /**
     * Initialize the breathing system
     */
    function init() {
        console.log('🫁 φ-Breath System initialized');
        console.log(`   Base Duration: ${BASE_DURATION}ms`);
        console.log(`   φ^0 (Exhale): 1.0x = ${BASE_DURATION}ms`);
        console.log(`   φ^1 (Inhale): ${φ.toFixed(3)}x = ${Math.round(BASE_DURATION * φ)}ms`);
        
        breathStartTime = performance.now();
        startBreathingCycle();
    }
    
    /**
     * Start the continuous breathing cycle
     */
    function startBreathingCycle() {
        const currentTime = performance.now();
        const elapsed = currentTime - breathStartTime;
        const progress = (elapsed % currentCycleDuration) / currentCycleDuration;
        
        // Calculate current breath phase (sinusoidal breathing)
        // 0.0 → 0.5: Inhale (φ^0 → φ^1)
        // 0.5 → 1.0: Exhale (φ^1 → φ^0)
        const breathPhase = Math.sin(progress * Math.PI * 2);
        
        // Map to φ scale: 1.0 → 1.618 → 1.0
        const φScale = 1.0 + ((φ - 1.0) * ((breathPhase + 1) / 2));
        
        // Determine phase
        const newPhase = progress < 0.5 ? 'inhale' : 'exhale';
        if (newPhase !== currentPhase && currentPhase !== 'creation') {
            currentPhase = newPhase;
            emit('phaseChange', { phase: currentPhase, scale: φScale, progress });
        }
        
        // Check for breath cycle completion (guard prevents multiple events)
        const breathTimestamp = Math.floor(elapsed / currentCycleDuration);
        if (breathTimestamp > lastBreathTimestamp && elapsed > 100) {
            lastBreathTimestamp = breathTimestamp;
            onBreathComplete();
        }
        
        // Emit continuous breath cycle event
        emit('breathCycle', {
            φScale,
            progress,
            phase: currentPhase,
            breathCount,
            elapsed
        });
        
        animationFrameId = requestAnimationFrame(startBreathingCycle);
    }
    
    /**
     * Handle breath cycle completion
     */
    function onBreathComplete() {
        breathCount++;
        
        const breathData = {
            count: breathCount,
            timestamp: new Date().toISOString(),
            duration: currentCycleDuration,
            phase: currentPhase
        };
        
        // Log the breath
        breathLog.push(breathData);
        if (breathLog.length > MAX_LOG_SIZE) {
            breathLog.shift();
        }
        
        // φ-breath counter increments with each breath
        // Genesis counter (server-side) increments in parallel as red herring
        console.log(`🫁 Breath #${breathCount} | ${currentPhase} | ${currentCycleDuration}ms | ${new Date().toLocaleTimeString()}`);
        
        emit('breathStart', breathData);
    }
    
    /**
     * Enter "creation spin" mode (fast spinning during expansion)
     */
    function enterCreationMode() {
        currentPhase = 'creation';
        emit('creation', { state: 'start' });
        console.log('🌀 Entered CREATION MODE - fast spinning');
    }
    
    /**
     * Exit "creation spin" mode (return to normal breathing)
     */
    function exitCreationMode() {
        currentPhase = 'idle';
        breathStartTime = performance.now(); // Reset breath cycle
        lastBreathTimestamp = 0; // Reset guard
        emit('creation', { state: 'end' });
        console.log('😌 Exited CREATION MODE - returning to φ-breath');
    }
    
    /**
     * Set breath cycle duration
     */
    function setDuration(durationMs) {
        currentCycleDuration = durationMs;
        console.log(`🫁 Breath duration set to ${durationMs}ms`);
    }
    
    /**
     * Get init time for external timing calculations
     */
    function getInitTime() {
        return breathStartTime;
    }
    
    /**
     * Get current breath state (enhanced with timing information)
     * Uses currentCycleDuration for accurate synchronization under dynamic speeds
     */
    function getBreathState() {
        const now = performance.now();
        const elapsed = (now - breathStartTime) % currentCycleDuration;
        const normalizedProgress = elapsed / currentCycleDuration;
        
        // Calculate φScale using same formula as breathCycle
        // Sinusoidal breathing: 1.0 → 1.618 → 1.0
        const breathPhase = Math.sin(normalizedProgress * Math.PI * 2);
        const φScale = 1.0 + ((φ - 1.0) * ((breathPhase + 1) / 2));
        
        // φ¹ peak occurs at 50% of cycle (inhale maximum)
        const φPeakTime = currentCycleDuration * 0.5;
        const timeUntilPhiPeak = elapsed < φPeakTime 
            ? φPeakTime - elapsed 
            : (currentCycleDuration - elapsed) + φPeakTime;
        
        return {
            initTime: breathStartTime,
            breathCount,
            phase: currentPhase,
            duration: currentCycleDuration,
            elapsed,
            progress: normalizedProgress,
            φScale,
            timeUntilPhiPeak,
            log: [...breathLog]
        };
    }
    
    /**
     * Event system - Subscribe to breath events
     */
    function on(eventName, callback) {
        if (listeners[eventName]) {
            listeners[eventName].push(callback);
        }
    }
    
    /**
     * Event system - Unsubscribe from breath events
     */
    function off(eventName, callback) {
        if (listeners[eventName]) {
            const index = listeners[eventName].indexOf(callback);
            if (index > -1) {
                listeners[eventName].splice(index, 1);
            }
        }
    }
    
    /**
     * Event system - Emit events
     */
    function emit(eventName, data) {
        if (listeners[eventName]) {
            listeners[eventName].forEach(callback => callback(data));
        }
    }
    
    /**
     * Stop the breathing cycle (cleanup)
     */
    function stop() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        console.log('🫁 φ-Breath System stopped');
    }
    
    // Public API
    return {
        init,
        on,
        off,
        enterCreationMode,
        exitCreationMode,
        setDuration,
        getInitTime,
        getBreathState,
        stop,
        
        // Constants
        φ,
        BASE_DURATION,
        
        // Calculated values
        get φ0() { return BASE_DURATION; },
        get φ1() { return Math.round(BASE_DURATION * φ); },
        
        // Timing access for jump-to-message sync
        get initTime() { return breathStartTime; }
    };
})();

// Auto-initialize if not in module context
if (typeof module === 'undefined') {
    console.log('🫁 φ-Breath module loaded');
}
