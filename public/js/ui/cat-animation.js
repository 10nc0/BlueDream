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
        
        const scale = CAT_CONFIG.SCALE;
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
        
        // Tail (curved up)
        ctx.fillRect(25 * scale + offsetX + centerX, 23 * scale + yOffset + offsetY + centerY, 2 * scale, 4 * scale);
        ctx.fillRect(26 * scale + offsetX + centerX, 20 * scale + yOffset + offsetY + centerY, 2 * scale, 3 * scale);
        
        // Eyes (green glow)
        ctx.fillStyle = CAT_CONFIG.COLORS.EYES;
        ctx.fillRect(17 * scale + offsetX + centerX, 17 * scale + yOffset + offsetY + centerY, 2 * scale, 2 * scale);
        ctx.fillRect(21 * scale + offsetX + centerX, 17 * scale + yOffset + offsetY + centerY, 2 * scale, 2 * scale);
        
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
        
        // Alternate time color with cat animation (black vs white)
        // Use class toggle instead of per-frame style.color to avoid layout thrashing
        const isJump = Math.floor(frame / CAT_CONFIG.JUMP_FRAME_INTERVAL) % 2 === 0;
        const shouldBeActive = isJump;
        
        // Only toggle class when state changes (not every frame)
        if (shouldBeActive !== _lastBlinkState) {
            _lastBlinkState = shouldBeActive;
            const timeEl = document.getElementById('currentTime');
            const timeElCompact = document.getElementById('currentTimeCompact');
            
            if (timeEl) {
                timeEl.classList.toggle('blink-active', shouldBeActive);
                timeEl.classList.toggle('blink-idle', !shouldBeActive);
            }
            if (timeElCompact) {
                timeElCompact.classList.toggle('blink-active', shouldBeActive);
                timeElCompact.classList.toggle('blink-idle', !shouldBeActive);
            }
        }
        
        drawPixelCat(frame, offsetX, offsetY, fleeing);
        frame++;
        requestAnimationFrame(animate);
    }
    
    animate();
}

// ========================================
// DATE/TIME TICKER (Independent Module)
// ========================================
// Updates #currentTime and #currentTimeCompact elements every second
// Works independently of cat animation - can exist in any layout position

let _dateTimeInitialized = false;

function initDateTimeTicker() {
    if (_dateTimeInitialized) return; // Singleton guard
    
    const timeEl = document.getElementById('currentTime');
    const timeElCompact = document.getElementById('currentTimeCompact');
    
    if (!timeEl && !timeElCompact) return; // No time elements found
    
    _dateTimeInitialized = true;
    
    function updateTime() {
        const now = new Date();
        const dateStr = now.toLocaleString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        const timeStr = now.toLocaleString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
        
        // Format as two-line: date on top, time on bottom
        if (timeEl) {
            timeEl.innerHTML = `${dateStr}<br>${timeStr}`;
        }
        if (timeElCompact) {
            timeElCompact.innerHTML = `${dateStr}<br>${timeStr}`;
        }
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
