// ========================================
// GLOBAL CONSTANT #2: CAT ANIMATION CONFIG
// ========================================
// UNIVERSE FRAME TRANSCENDENTAL CAT COMPONENT
// This is a unique, self-contained object that exists independently
// across all pages and contexts. Protected from dynamic UI changes.
// Can be used anywhere by including cat-animation.html component.

const CAT_CONFIG = Object.freeze({
    // Canvas ID (dimensions read dynamically from actual canvas element)
    CANVAS_ID: 'hopCanvas',
    
    // Animation settings
    SCALE: 2.8,
    ANIMATION_SPEED: 60,
    JUMP_FRAME_INTERVAL: 15,
    JUMP_HEIGHT: 2,
    
    // Interaction settings (responsive wiggle)
    FLEE_DISTANCE: 150,      // Desktop: subtle interaction
    FLEE_STRENGTH: 8,        // Desktop: considerate wiggle room
    MOBILE_FLEE_DISTANCE: 120, // Mobile: responsive to tap (reduced range)
    MOBILE_FLEE_STRENGTH: 6,   // Mobile: gentle wiggle on tap
    
    // Colors
    COLORS: {
        BODY: '#1a1a1a',
        EAR_INNER: '#3a2a2a',
        EYES: '#22c55e',
        NOSE: '#ec4899',
        WHISKERS: '#ffffff',
        TIME_ACTIVE: '#1a1a1a',
        TIME_IDLE: '#ffffff'
    }
});

// Initialize cat animation (universe frame transcendental)
// This function can be called from any page
function initHopAnimation() {
    const canvas = document.getElementById(CAT_CONFIG.CANVAS_ID);
    if (!canvas) {
        console.warn('⚠️ Cat canvas not found! Include cat-animation.html component.');
        return;
    }
    console.log('🐱 Initializing transcendental cat animation...');
    
    const ctx = canvas.getContext('2d');
    // Read actual canvas dimensions dynamically (supports 100x100, 125x125, etc.)
    const CANVAS_WIDTH = canvas.width;
    const CANVAS_HEIGHT = canvas.height;
    
    let frame = 0;
    let mouseX = -1000;
    let mouseY = -1000;
    let catX = CANVAS_WIDTH / 2;
    let catY = CANVAS_HEIGHT / 2;
    let lastTouchTime = 0;
    let lastInteractionTime = 0;
    let _lastBlinkState = null; // Track blink state to avoid per-frame DOM mutations
    let blinkUntil = 0;
    let nextBlink = Date.now() + 5000 + Math.random() * 3000;
    const TOUCH_COOLDOWN = 100; // ms - prevent ghost/rapid-fire taps
    const IDLE_RESET_TIME = 2000; // ms - reset to center after 2s of no interaction
    
    // Detect if mobile mode (portrait on small screen)
    const isMobileMode = () => window.innerWidth < 768 && window.innerHeight > window.innerWidth;
    
    // Track mouse position globally for cursor-based wiggle (area tracking)
    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
        lastInteractionTime = Date.now();
    });
    
    // Touch support for tap-based wiggle (instance tracking)
    // Scoped to canvas only to prevent form field interference
    let isTouchingCat = false;
    
    canvas.addEventListener('touchstart', (e) => {
        const now = Date.now();
        // Ignore rapid-fire or ghost taps (cached touch events)
        if (now - lastTouchTime < TOUCH_COOLDOWN) return;
        lastTouchTime = now;
        lastInteractionTime = now;
        
        isTouchingCat = true;
        if (e.touches.length > 0) {
            mouseX = e.touches[0].clientX;
            mouseY = e.touches[0].clientY;
        }
    });
    
    document.addEventListener('touchmove', (e) => {
        // Only update position if actively touching the cat
        if (isTouchingCat && e.touches.length > 0) {
            mouseX = e.touches[0].clientX;
            mouseY = e.touches[0].clientY;
            lastInteractionTime = Date.now();
        }
    });
    
    // Reset mouse position on touchend to prevent ghost tap persistence
    document.addEventListener('touchend', () => {
        isTouchingCat = false;
        mouseX = -1000;
        mouseY = -1000;
    });
    
    function drawPixelCat(frameNum, offsetX = 0, offsetY = 0, fleeing = false) {
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        
        const scale = parseFloat(canvas.dataset.scale) || (canvas.width / 125) * CAT_CONFIG.SCALE;
        const isJump = Math.floor(frameNum / CAT_CONFIG.JUMP_FRAME_INTERVAL) % 2 === 0;
        const yOffset = isJump ? -CAT_CONFIG.JUMP_HEIGHT * scale : 0;
        
        // Center the cat in the canvas (above time & date)
        // Cat coordinate system: X spans 12→28 (width=16), Y spans 12→32 (height=20)
        // Cat's center point in coordinate space: (20, 22)
        const catCenterX = 20; // (12 + 28) / 2
        const catCenterY = 22; // (12 + 32) / 2
        const centerX = (CANVAS_WIDTH / 2) - (catCenterX * scale);
        const centerY = (CANVAS_HEIGHT / 2) - (catCenterY * scale);
        
        // Flip cat if fleeing (running away)
        if (fleeing) {
            ctx.save();
            ctx.translate(CANVAS_WIDTH, 0);
            ctx.scale(-1, 1);
        }
        
        // Black cat body
        ctx.fillStyle = CAT_CONFIG.COLORS.BODY;
        
        // Body (main)
        ctx.fillRect(14 * scale + offsetX + centerX, 22 * scale + yOffset + offsetY + centerY, 12 * scale, 8 * scale);
        
        // Head
        ctx.fillRect(15 * scale + offsetX + centerX, 15 * scale + yOffset + offsetY + centerY, 10 * scale, 7 * scale);
        
        // Ears (pointy cat ears) - These are the TOP-MOST pixels
        ctx.fillRect(15 * scale + offsetX + centerX, 12 * scale + yOffset + offsetY + centerY, 3 * scale, 3 * scale);
        ctx.fillRect(22 * scale + offsetX + centerX, 12 * scale + yOffset + offsetY + centerY, 3 * scale, 3 * scale);

        // Inner ears (warm dark highlight inside each ear)
        ctx.fillStyle = CAT_CONFIG.COLORS.EAR_INNER;
        ctx.fillRect(15.75 * scale + offsetX + centerX, 12.5 * scale + yOffset + offsetY + centerY, 1.5 * scale, 2 * scale);
        ctx.fillRect(22.75 * scale + offsetX + centerX, 12.5 * scale + yOffset + offsetY + centerY, 1.5 * scale, 2 * scale);

        // Tail (curved up, gently swaying) — reset to body colour after inner ears
        ctx.fillStyle = CAT_CONFIG.COLORS.BODY;
        const tailSway = Math.sin(frameNum / 28) * 1.2 * scale;
        ctx.fillRect(25 * scale + offsetX + centerX + tailSway, 23 * scale + yOffset + offsetY + centerY, 2 * scale, 4 * scale);
        ctx.fillRect(26 * scale + offsetX + centerX + tailSway, 20 * scale + yOffset + offsetY + centerY, 2 * scale, 3 * scale);

        // Blink state (passive check — no side effects, no setTimeout)
        const isBlinking = Date.now() < blinkUntil;
        if (Date.now() > nextBlink && !isBlinking) {
            blinkUntil = Date.now() + 260;
            nextBlink = Date.now() + 5000 + Math.random() * 3000;
        }

        // Eyes (green glow)
        ctx.fillStyle = CAT_CONFIG.COLORS.EYES;
        const eyeH = isBlinking ? 0.3 * scale : 2 * scale;
        ctx.fillRect(17 * scale + offsetX + centerX, 17 * scale + yOffset + offsetY + centerY, 2 * scale, eyeH);
        ctx.fillRect(21 * scale + offsetX + centerX, 17 * scale + yOffset + offsetY + centerY, 2 * scale, eyeH);
        
        // Nose (pink)
        ctx.fillStyle = CAT_CONFIG.COLORS.NOSE;
        ctx.fillRect(19 * scale + offsetX + centerX, 20 * scale + yOffset + offsetY + centerY, 2 * scale, 1 * scale);
        
        // Whiskers (white) - These are the LEFT-MOST pixels
        ctx.fillStyle = CAT_CONFIG.COLORS.WHISKERS;
        if (!isJump) {
            // Left whiskers
            ctx.fillRect(12 * scale + offsetX + centerX, 19 * scale + offsetY + centerY, 2 * scale, 1 * scale);
            ctx.fillRect(12 * scale + offsetX + centerX, 21 * scale + offsetY + centerY, 2 * scale, 1 * scale);
            // Right whiskers
            ctx.fillRect(26 * scale + offsetX + centerX, 19 * scale + offsetY + centerY, 2 * scale, 1 * scale);
            ctx.fillRect(26 * scale + offsetX + centerX, 21 * scale + offsetY + centerY, 2 * scale, 1 * scale);
        }
        
        // Feet/paws
        ctx.fillStyle = CAT_CONFIG.COLORS.BODY;
        if (!isJump) {
            ctx.fillRect(15 * scale + offsetX + centerX, 30 * scale + offsetY + centerY, 3 * scale, 2 * scale);
            ctx.fillRect(22 * scale + offsetX + centerX, 30 * scale + offsetY + centerY, 3 * scale, 2 * scale);
        }
        
        if (fleeing) {
            ctx.restore();
        }
    }
    
    function animate() {
        // Responsive wiggle: Adjust based on mode
        const fleeDistance = isMobileMode() ? CAT_CONFIG.MOBILE_FLEE_DISTANCE : CAT_CONFIG.FLEE_DISTANCE;
        const fleeStrength = isMobileMode() ? CAT_CONFIG.MOBILE_FLEE_STRENGTH : CAT_CONFIG.FLEE_STRENGTH;
        
        let offsetX = 0;
        let offsetY = 0;
        let fleeing = false;
        
        // Check if cat should reset to center (idle timeout)
        const timeSinceInteraction = Date.now() - lastInteractionTime;
        const isIdle = timeSinceInteraction > IDLE_RESET_TIME;
        
        // If idle, smoothly reset cursor position to far away (resets cat to center)
        if (isIdle && (mouseX !== -1000 || mouseY !== -1000)) {
            mouseX = -1000;
            mouseY = -1000;
        }
        
        // Calculate mouse interaction (cursor area tracking for desktop, tap instance tracking for mobile)
        if (fleeDistance > 0 && !isIdle) {
            const rect = canvas.getBoundingClientRect();
            const canvasCenterX = rect.left + rect.width / 2;
            const canvasCenterY = rect.top + rect.height / 2;
            
            // Calculate distance from mouse to canvas center
            const dx = mouseX - canvasCenterX;
            const dy = mouseY - canvasCenterY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // Cat behavior: flee if cursor is close (within FLEE_DISTANCE), otherwise neutral
            if (distance < fleeDistance) {
                // Flee away from cursor with subtle wiggle
                fleeing = true;
                const strength = fleeStrength * (1 - distance / fleeDistance);
                offsetX = -(dx / distance) * strength;
                offsetY = -(dy / distance) * strength;
            }
        }
        
        // Date/time breathing animation is now handled purely by CSS (breathe-datetime keyframes)
        // No more JS-controlled rapid blink toggling - gentler, consistent tempo
        
        drawPixelCat(frame, offsetX, offsetY, fleeing);
        frame++;
        requestAnimationFrame(animate);
    }
    
    animate();
}

// ========================================
// DATE/TIME TICKER (Auth Pages Only)
// ========================================
// SINGLE LINE FORMAT for auth pages (cat-animation component)
// Playground & main index have their own time updaters in their JS files

let _dateTimeInitialized = false;

function initDateTimeTicker() {
    if (_dateTimeInitialized) return; // Singleton guard
    
    const timeEl = document.getElementById('currentTime');
    const timeElCompact = document.getElementById('currentTimeCompact');
    
    if (!timeEl && !timeElCompact) return;
    
    // Skip if playground.js or dashboard.js will handle time (detected by .date-time-display class)
    const hasPlaygroundTimeDisplay = (timeEl && timeEl.parentElement?.classList?.contains('date-time-display')) ||
                                    (timeElCompact && timeElCompact.parentElement?.classList?.contains('date-time-display'));
    
    if (hasPlaygroundTimeDisplay) {
        console.log('⏰ Skipping cat-animation time updater (playground/dashboard handles its own)');
        return;
    }
    
    _dateTimeInitialized = true;
    console.log('⏰ Initializing single-line date/time ticker for auth pages');
    
    function updateTime() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const ampm = now.getHours() >= 12 ? 'PM' : 'AM';
        const displayHours = now.getHours() % 12 || 12;
        
        const formatted = `${year}/${month}/${day} - ${String(displayHours).padStart(2, '0')}:${minutes}:${seconds}${ampm}`;
        
        if (timeEl) timeEl.textContent = formatted;
        if (timeElCompact) timeElCompact.textContent = formatted;
    }
    
    updateTime();
    setInterval(updateTime, 1000);
}

// ========================================
// AUTO-INITIALIZATION (Self-Starting)
// ========================================
// Both cat animation and date/time ticker auto-start on DOMContentLoaded
// Each detects its own elements independently

let _catInitialized = false;

// Wrap original initHopAnimation with singleton guard
const _originalInitHopAnimation = initHopAnimation;
initHopAnimation = function() {
    if (_catInitialized) return; // Prevent double-init
    _catInitialized = true;
    _originalInitHopAnimation();
};

document.addEventListener('DOMContentLoaded', () => {
    // Auto-init cat animation if canvas exists
    if (document.getElementById('hopCanvas')) {
        initHopAnimation();
    }
    
    // Auto-init date/time ticker if time elements exist
    initDateTimeTicker();
});
