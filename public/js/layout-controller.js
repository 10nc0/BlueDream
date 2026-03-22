/**
 * LAYOUT CONTROLLER - Unified state machine for UI modes
 * 
 * Consolidates scattered layout state (isMobile, isExpanded, expandLock, etc.)
 * into a single source of truth with explicit state transitions.
 * 
 * States:
 * - device: 'mobile' | 'desktop' (derived from viewport)
 * - expansion: 'collapsed' | 'expanding' | 'expanded' | 'collapsing'
 * - focus: 'library' | 'messages' | 'audit' (which pane is active)
 */
const LayoutController = (function() {
    'use strict';
    
    // ===== CONSTANTS =====
    const MOBILE_BREAKPOINT = 768;
    const ASPECT_RATIO_THRESHOLD = 1.4;
    const EXPAND_DELAY_MS = 50;
    const COLLAPSE_DELAY_MS = 40;
    const ANIMATION_DURATION_MS = 400;
    const TOGGLE_DEBOUNCE_MS = 100;
    
    // ===== STATE =====
    const state = {
        device: 'desktop',
        expansion: 'collapsed',
        focus: 'library',
        breathInitialized: false,
        lastToggleTime: 0,
        idleTimer: null
    };
    
    // ===== SUBSCRIBERS =====
    const subscribers = [];
    
    function subscribe(callback) {
        subscribers.push(callback);
        return () => {
            const idx = subscribers.indexOf(callback);
            if (idx > -1) subscribers.splice(idx, 1);
        };
    }
    
    function notify(event, data) {
        subscribers.forEach(cb => cb(event, data, state));
    }
    
    // ===== DEVICE DETECTION =====
    function detectDevice() {
        const aspectRatio = window.innerHeight / window.innerWidth;
        
        if (window.innerWidth < MOBILE_BREAKPOINT && window.innerHeight > window.innerWidth) {
            return 'mobile';
        }
        
        if (aspectRatio > ASPECT_RATIO_THRESHOLD) {
            return 'mobile';
        }
        
        return 'desktop';
    }
    
    function isMobile() {
        return state.device === 'mobile';
    }
    
    function isExpanded() {
        return state.expansion === 'expanded';
    }
    
    function isAnimating() {
        return state.expansion === 'expanding' || state.expansion === 'collapsing';
    }
    
    // ===== DOM HELPERS =====
    function getElements() {
        return {
            body: document.body,
            catCanvas: document.getElementById('hopCanvas'),
            sidebarResizer: document.getElementById('sidebarResizer'),
            headerResizer: document.getElementById('headerResizer'),
            bookSidebar: document.querySelector('.book-sidebar'),
            thumbsZone: document.getElementById('thumbsZone'),
            layer01: document.querySelector('.thumbs-zone .layer-01'),
            singularityBtn: document.querySelector('.singularity-btn')
        };
    }
    
    // ===== DEVICE MODE TRANSITIONS =====
    function applyDeviceMode(device) {
        const el = getElements();
        
        if (device === 'mobile') {
            console.log('📱 LayoutController: MOBILE mode');
            el.body.classList.add('mobile-mode');
            el.body.classList.remove('desktop-mode');
            
            if (el.catCanvas) {
                el.catCanvas.width = 75;
                el.catCanvas.height = 75;
                el.catCanvas.style.width = '75px';
                el.catCanvas.style.height = '75px';
            }
            
            if (el.sidebarResizer) el.sidebarResizer.style.display = 'none';
            if (el.headerResizer) el.headerResizer.style.display = 'none';
            if (el.bookSidebar) el.bookSidebar.style.display = 'none';
            
            ensureThumbsZone();
            initBreathSystem();
        } else {
            console.log('💻 LayoutController: DESKTOP mode');
            el.body.classList.add('desktop-mode');
            el.body.classList.remove('mobile-mode');
            
            clearIdleTimer();
            
            if (el.catCanvas) {
                el.catCanvas.width = 143;
                el.catCanvas.height = 143;
                el.catCanvas.style.width = '';
                el.catCanvas.style.height = '';
            }
            
            if (el.sidebarResizer) el.sidebarResizer.style.display = 'block';
            if (el.headerResizer) el.headerResizer.style.display = 'block';
            if (el.bookSidebar) el.bookSidebar.style.display = '';
            
            if (el.thumbsZone) el.thumbsZone.style.display = 'none';
        }
        
        state.device = device;
        notify('deviceChanged', { device });
    }
    
    function ensureThumbsZone() {
        let thumbsZone = document.getElementById('thumbsZone');
        
        if (!thumbsZone) {
            thumbsZone = document.createElement('div');
            thumbsZone.id = 'thumbsZone';
            thumbsZone.className = 'thumbs-zone';
            document.body.appendChild(thumbsZone);
        }
        
        thumbsZone.style.display = 'flex';
        notify('thumbsZoneReady', { element: thumbsZone });
    }
    
    function initBreathSystem() {
        if (state.breathInitialized) return;
        
        if (typeof PHI_BREATH !== 'undefined' && PHI_BREATH.init) {
            console.log('🫁 LayoutController: Initializing φ-breath');
            PHI_BREATH.init();
            state.breathInitialized = true;
        }
    }
    
    // ===== EXPANSION STATE MACHINE =====
    function expand() {
        if (isAnimating() || isExpanded()) {
            console.log('⏸️ Expand blocked: already expanded or animating');
            return false;
        }
        
        const now = Date.now();
        if (now - state.lastToggleTime < TOGGLE_DEBOUNCE_MS) {
            console.log('⏸️ Expand throttled');
            return false;
        }
        state.lastToggleTime = now;
        
        state.expansion = 'expanding';
        console.log('🌌 LayoutController: EXPAND');
        
        clearIdleTimer();
        
        if (typeof CAT_BREATHE_CLOCK !== 'undefined') {
            CAT_BREATHE_CLOCK.setSpeed('FAST');
        }
        
        if (isMobile() && state.breathInitialized && typeof PHI_BREATH !== 'undefined') {
            PHI_BREATH.enterCreationMode();
        }
        
        const el = getElements();
        if (el.layer01) {
            el.layer01.removeAttribute('hidden');
            el.layer01.classList.remove('collapsing');
            el.layer01.classList.add('show');
            
            const eggs = el.layer01.querySelectorAll('.thumb-btn');
            eggs.forEach((egg, i) => {
                egg.style.transitionDelay = `${i * EXPAND_DELAY_MS}ms`;
            });
            
            const totalDuration = ANIMATION_DURATION_MS + eggs.length * EXPAND_DELAY_MS;
            setTimeout(() => {
                state.expansion = 'expanded';
                notify('expanded', {});
            }, totalDuration);
        } else {
            state.expansion = 'expanded';
            notify('expanded', {});
        }
        
        if (isMobile()) {
            const breathDuration = state.breathInitialized && typeof PHI_BREATH !== 'undefined' 
                ? PHI_BREATH.BASE_DURATION 
                : 4000;
            
            state.idleTimer = setTimeout(() => {
                console.log('⏰ Auto-collapse after φ-breath');
                if (isExpanded()) {
                    collapse();
                }
            }, breathDuration);
        }
        
        return true;
    }
    
    function collapse() {
        if (isAnimating() || !isExpanded()) {
            console.log('⏸️ Collapse blocked: already collapsed or animating');
            return false;
        }
        
        state.expansion = 'collapsing';
        console.log('🔄 LayoutController: COLLAPSE');
        
        clearIdleTimer();
        
        if (isMobile() && state.breathInitialized && typeof PHI_BREATH !== 'undefined') {
            PHI_BREATH.exitCreationMode();
        }
        
        const el = getElements();
        if (el.layer01) {
            el.layer01.classList.remove('show');
            el.layer01.classList.add('collapsing');
            
            const eggs = [...el.layer01.querySelectorAll('.thumb-btn')].reverse();
            eggs.forEach((egg, i) => {
                egg.style.transitionDelay = `${i * COLLAPSE_DELAY_MS}ms`;
            });
            
            const totalDuration = ANIMATION_DURATION_MS + eggs.length * COLLAPSE_DELAY_MS;
            setTimeout(() => {
                el.layer01.classList.remove('collapsing');
                el.layer01.setAttribute('hidden', '');
                
                if (typeof CAT_BREATHE_CLOCK !== 'undefined') {
                    CAT_BREATHE_CLOCK.setSpeed('SLOW');
                }
                
                state.expansion = 'collapsed';
                notify('collapsed', {});
            }, totalDuration);
        } else {
            if (typeof CAT_BREATHE_CLOCK !== 'undefined') {
                CAT_BREATHE_CLOCK.setSpeed('SLOW');
            }
            state.expansion = 'collapsed';
            notify('collapsed', {});
        }
        
        return true;
    }
    
    function toggle() {
        return isExpanded() ? collapse() : expand();
    }
    
    function clearIdleTimer() {
        if (state.idleTimer) {
            clearTimeout(state.idleTimer);
            state.idleTimer = null;
        }
    }
    
    // ===== FOCUS MANAGEMENT =====
    function setFocus(pane) {
        if (!['library', 'messages', 'audit'].includes(pane)) {
            console.warn('Invalid focus pane:', pane);
            return;
        }
        
        const prev = state.focus;
        state.focus = pane;
        notify('focusChanged', { from: prev, to: pane });
    }
    
    // ===== INITIALIZATION =====
    function init() {
        const device = detectDevice();
        applyDeviceMode(device);
        
        window.addEventListener('resize', handleResize);
        
        console.log('📐 LayoutController initialized:', state);
        return state;
    }
    
    let resizeDebounce = null;
    function handleResize() {
        if (resizeDebounce) clearTimeout(resizeDebounce);
        resizeDebounce = setTimeout(() => {
            const newDevice = detectDevice();
            if (newDevice !== state.device) {
                applyDeviceMode(newDevice);
            }
        }, 100);
    }
    
    // ===== PUBLIC API =====
    return {
        init,
        subscribe,
        
        isMobile,
        isExpanded,
        isAnimating,
        
        expand,
        collapse,
        toggle,
        
        setFocus,
        getFocus: () => state.focus,
        
        getState: () => ({ ...state }),
        
        CONSTANTS: {
            MOBILE_BREAKPOINT,
            ASPECT_RATIO_THRESHOLD,
            EXPAND_DELAY_MS,
            COLLAPSE_DELAY_MS,
            ANIMATION_DURATION_MS
        }
    };
})();

if (typeof window !== 'undefined') {
    window.LayoutController = LayoutController;
}
