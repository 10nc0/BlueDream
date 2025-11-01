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
    
    // Interaction settings
    FLEE_DISTANCE: 200,
    FLEE_STRENGTH: 15,
    
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
    
    // Detect if mobile mode (portrait on small screen)
    const isMobileMode = () => window.innerWidth < 768 && window.innerHeight > window.innerWidth;
    
    // Track mouse position globally (DISABLED on mobile for edge-snapping)
    if (!isMobileMode()) {
        document.addEventListener('mousemove', (e) => {
            mouseX = e.clientX;
            mouseY = e.clientY;
        });
        
        // Touch support for iPad in landscape (desktop mode)
        document.addEventListener('touchmove', (e) => {
            if (e.touches.length > 0) {
                mouseX = e.touches[0].clientX;
                mouseY = e.touches[0].clientY;
            }
        });
        
        document.addEventListener('touchstart', (e) => {
            if (e.touches.length > 0) {
                mouseX = e.touches[0].clientX;
                mouseY = e.touches[0].clientY;
            }
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
        // Mobile mode: NO mouse interaction, cat stays locked at top-left
        let offsetX = 0;
        let offsetY = 0;
        let fleeing = false;
        
        if (!isMobileMode()) {
            // Desktop mode: Enable mouse flee behavior
            const rect = canvas.getBoundingClientRect();
            const canvasCenterX = rect.left + rect.width / 2;
            const canvasCenterY = rect.top + rect.height / 2;
            
            // Calculate distance from mouse to canvas center
            const dx = mouseX - canvasCenterX;
            const dy = mouseY - canvasCenterY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // Cat behavior: flee if cursor is close (within FLEE_DISTANCE), otherwise neutral
            if (distance < CAT_CONFIG.FLEE_DISTANCE) {
                // Flee away from cursor
                fleeing = true;
                const fleeStrength = CAT_CONFIG.FLEE_STRENGTH * (1 - distance / CAT_CONFIG.FLEE_DISTANCE);
                offsetX = -(dx / distance) * fleeStrength;
                offsetY = -(dy / distance) * fleeStrength;
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
