// ========================================
// GLOBAL CONSTANT #2: CAT ANIMATION CONFIG
// ========================================
// UNIVERSE FRAME TRANSCENDENTAL CAT COMPONENT
// This is a unique, self-contained object that exists independently
// across all pages and contexts. Protected from dynamic UI changes.
// Can be used anywhere by including cat-animation.html component.

const CAT_CONFIG = Object.freeze({
    // Canvas dimensions (fixed, immutable)
    CANVAS_WIDTH: 100,
    CANVAS_HEIGHT: 100,
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
    let frame = 0;
    let mouseX = -1000;
    let mouseY = -1000;
    let catX = CAT_CONFIG.CANVAS_WIDTH / 2;
    let catY = CAT_CONFIG.CANVAS_HEIGHT / 2;
    let lastTouchTime = 0;
    const TOUCH_COOLDOWN = 100; // ms - prevent ghost/rapid-fire taps
    
    // Detect if mobile mode (portrait on small screen)
    const isMobileMode = () => window.innerWidth < 768 && window.innerHeight > window.innerWidth;
    
    // Detect if on login/signup/forgot-password pages (non-interactive mode)
    const isAuthPage = window.location.pathname.includes('/login') || 
                       window.location.pathname.includes('/signup') ||
                       window.location.pathname.includes('/forgot-password');
    
    // Only enable interaction on dashboard/authenticated pages
    if (!isAuthPage) {
        // Track mouse position globally (ALWAYS enabled for responsive wiggle)
        document.addEventListener('mousemove', (e) => {
            mouseX = e.clientX;
            mouseY = e.clientY;
        });
        
        // Touch support for iPad and mobile devices
        // Only track touches on the cat canvas itself (prevent form field interference)
        let isTouchingCat = false;
        
        canvas.addEventListener('touchstart', (e) => {
            const now = Date.now();
            // Ignore rapid-fire or ghost taps (cached touch events)
            if (now - lastTouchTime < TOUCH_COOLDOWN) return;
            lastTouchTime = now;
            
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
            }
        });
        
        // Reset mouse position on touchend to prevent ghost tap persistence
        document.addEventListener('touchend', () => {
            isTouchingCat = false;
            mouseX = -1000;
            mouseY = -1000;
        });
    }
    
    function drawPixelCat(frameNum, offsetX = 0, offsetY = 0, fleeing = false) {
        ctx.clearRect(0, 0, CAT_CONFIG.CANVAS_WIDTH, CAT_CONFIG.CANVAS_HEIGHT);
        
        const scale = CAT_CONFIG.SCALE;
        const isJump = Math.floor(frameNum / CAT_CONFIG.JUMP_FRAME_INTERVAL) % 2 === 0;
        const yOffset = isJump ? -CAT_CONFIG.JUMP_HEIGHT * scale : 0;
        
        // Mobile: Snap to top-left (subtract minimum coordinates)
        // Desktop: Center in canvas (original coordinates)
        const snapX = isMobileMode() ? -12 * scale : 0; // Shift left by 12*scale
        const snapY = isMobileMode() ? -12 * scale : 0; // Shift up by 12*scale (ear position)
        
        // Flip cat if fleeing (running away)
        if (fleeing) {
            ctx.save();
            ctx.translate(CAT_CONFIG.CANVAS_WIDTH, 0);
            ctx.scale(-1, 1);
        }
        
        // Black cat body
        ctx.fillStyle = CAT_CONFIG.COLORS.BODY;
        
        // Body (main)
        ctx.fillRect(14 * scale + offsetX + snapX, 22 * scale + yOffset + offsetY + snapY, 12 * scale, 8 * scale);
        
        // Head
        ctx.fillRect(15 * scale + offsetX + snapX, 15 * scale + yOffset + offsetY + snapY, 10 * scale, 7 * scale);
        
        // Ears (pointy cat ears) - These are the TOP-MOST pixels
        ctx.fillRect(15 * scale + offsetX + snapX, 12 * scale + yOffset + offsetY + snapY, 3 * scale, 3 * scale);
        ctx.fillRect(22 * scale + offsetX + snapX, 12 * scale + yOffset + offsetY + snapY, 3 * scale, 3 * scale);
        
        // Tail (curved up)
        ctx.fillRect(25 * scale + offsetX + snapX, 23 * scale + yOffset + offsetY + snapY, 2 * scale, 4 * scale);
        ctx.fillRect(26 * scale + offsetX + snapX, 20 * scale + yOffset + offsetY + snapY, 2 * scale, 3 * scale);
        
        // Eyes (green glow)
        ctx.fillStyle = CAT_CONFIG.COLORS.EYES;
        ctx.fillRect(17 * scale + offsetX + snapX, 17 * scale + yOffset + offsetY + snapY, 2 * scale, 2 * scale);
        ctx.fillRect(21 * scale + offsetX + snapX, 17 * scale + yOffset + offsetY + snapY, 2 * scale, 2 * scale);
        
        // Nose (pink)
        ctx.fillStyle = CAT_CONFIG.COLORS.NOSE;
        ctx.fillRect(19 * scale + offsetX + snapX, 20 * scale + yOffset + offsetY + snapY, 2 * scale, 1 * scale);
        
        // Whiskers (white) - These are the LEFT-MOST pixels
        ctx.fillStyle = CAT_CONFIG.COLORS.WHISKERS;
        if (!isJump) {
            // Left whiskers
            ctx.fillRect(12 * scale + offsetX + snapX, 19 * scale + offsetY + snapY, 2 * scale, 1 * scale);
            ctx.fillRect(12 * scale + offsetX + snapX, 21 * scale + offsetY + snapY, 2 * scale, 1 * scale);
            // Right whiskers
            ctx.fillRect(26 * scale + offsetX + snapX, 19 * scale + offsetY + snapY, 2 * scale, 1 * scale);
            ctx.fillRect(26 * scale + offsetX + snapX, 21 * scale + offsetY + snapY, 2 * scale, 1 * scale);
        }
        
        // Feet/paws
        ctx.fillStyle = CAT_CONFIG.COLORS.BODY;
        if (!isJump) {
            ctx.fillRect(15 * scale + offsetX + snapX, 30 * scale + offsetY + snapY, 3 * scale, 2 * scale);
            ctx.fillRect(22 * scale + offsetX + snapX, 30 * scale + offsetY + snapY, 3 * scale, 2 * scale);
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
        
        // Calculate mouse interaction (desktop only if mobile settings are 0)
        if (fleeDistance > 0) {
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
        const isJump = Math.floor(frame / CAT_CONFIG.JUMP_FRAME_INTERVAL) % 2 === 0;
        const blinkColor = isJump ? CAT_CONFIG.COLORS.TIME_ACTIVE : CAT_CONFIG.COLORS.TIME_IDLE;
        
        const timeEl = document.getElementById('currentTime');
        if (timeEl) {
            timeEl.style.color = blinkColor;
        }
        
        // Also apply blinking to compact position
        const timeElCompact = document.getElementById('currentTimeCompact');
        if (timeElCompact) {
            timeElCompact.style.color = blinkColor;
        }
        
        drawPixelCat(frame, offsetX, offsetY, fleeing);
        frame++;
        requestAnimationFrame(animate);
    }
    
    animate();
}

// Note: initHopAnimation is called from index.html after authentication check
// This ensures the cat animation only runs for authenticated users
