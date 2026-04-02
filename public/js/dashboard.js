        console.log('🚀 Main script loading...');
        
        // ===================================================================
        // MODULAR ARCHITECTURE
        // StateService, AuthService, DataSync, BooksModule, MessagesModule loaded before dashboard.js
        // All state is managed via Nyan.StateService for PWA readiness
        // ===================================================================
        const _S = window.Nyan.StateService;
        const _A = window.Nyan.AuthService;
        const _B = window.Nyan.BooksModule;
        const _M = window.Nyan.MessagesModule;
        
        // State accessors - read from StateService, mutations update StateService
        // Objects/arrays are passed by reference, so mutations (push, splice, etc.) work
        // For reassignments, use the setter functions below
        let books = _S.getBooks();
        let filteredBooks = _S.getFilteredBooks();
        let editingBookId = _S.getEditingBookId();
        let expandedBots = _S.getExpandedBots();
        let messageCache = _S.getMessageCache();
        let allMessages = _S.getAllMessages();
        let currentUser = _S.getCurrentUser();
        let bookSearchContext = _S.getBookSearchContext();
        let botTags = _S.getBotTags();
        let botWebhooks = _S.getBotWebhooks();
        let users = _S.getUsers();
        let sessions = _S.getSessions();
        let selectedMessages = _S.getSelectedMessages();
        let messagePageState = _S.getMessagePageState();
        let scrollListenerAttached = _S.getScrollListenerAttached();
        let lensFilterState = _S.getLensFilterState();
        let selectedBookId = _S.getSelectedBookId();
        const roadmapGlossary = _S.getRoadmapGlossary();
        
        // State mutation helpers - for reassignments, update both local and StateService
        function setBooks(newBooks) { books = newBooks; _S.setBooks(newBooks); }
        function setFilteredBooks(newBooks) { filteredBooks = newBooks; _S.setFilteredBooks(newBooks); }
        function setCurrentUser(user) { currentUser = user; _S.setCurrentUser(user); }
        function setMessageCache(cache) { messageCache = cache; _S.setMessageCache(cache); }
        function setAllMessages(msgs) { allMessages = msgs; _S.setAllMessages(msgs); }
        function setBotTags(tags) { botTags = tags; _S.setBotTags(tags); }
        function setBotWebhooks(webhooks) { botWebhooks = webhooks; _S.setBotWebhooks(webhooks); }
        function setUsers(u) { users = u; _S.setUsers(u); }
        function setSessions(s) { sessions = s; _S.setSessions(s); }
        function setEditingBookId(id) { editingBookId = id; _S.setEditingBookId(id); }
        function setSelectedBookId(id) { selectedBookId = id; _S.setSelectedBookId(id); }

        // ===================================================================
        // UNIFIED ACTION REGISTRY
        // Central map for all buttons/actions (mobile + desktop)
        // This eliminates code duplication and creates single source of truth
        // ===================================================================
        
        const ACTION_REGISTRY = {
            singularity: {
                id: 'singularity',
                label: '☯️',
                icon: '☯️',
                mobileIcon: '☯️',
                desktopLabel: '☯️ Expand All',
                tooltip: 'Expand all actions (superposition state)',
                priority: 0, // Highest priority - always visible
                showInMobile: true,
                showInDesktop: false,
                requireAuth: true,
                handler: () => expandFromSingularity()
            },
            create: {
                id: 'create',
                label: '✍🏻 Create Book',
                icon: '✍🏻',
                mobileIcon: '✍🏻',
                desktopLabel: '✍🏻 Create Book',
                tooltip: 'Create a new book',
                priority: 1, // Lower = higher priority in mobile layout
                showInMobile: true,
                showInDesktop: true,
                requireAuth: true,
                handler: () => openCreatePopup()
            },
            bookinfo: {
                id: 'bookinfo',
                label: '📋 Book Info',
                icon: '📋',
                mobileIcon: '📋',
                desktopLabel: '📋 Book Info',
                tooltip: 'Book name and actions',
                priority: 2, // Position 4 in thumbs zone (4-3-2-1)
                showInMobile: true,
                showInDesktop: false,
                requireAuth: true,
                handler: () => showBookInfoModal()
            },
            audit: {
                id: 'audit',
                label: '🧿 AI Audit',
                icon: '🧿',
                mobileIcon: '🧿',
                desktopLabel: '🧿 AI Audit',
                tooltip: 'AI audit action & closure (ward off evil)',
                priority: 2,
                showInMobile: true,
                showInDesktop: true,
                requireAuth: true,
                handler: () => showNyanAuditModal()
            },
            history: {
                id: 'history',
                label: '📜 AI History',
                icon: '🧠',
                mobileIcon: '🧠',
                desktopLabel: '📜 AI History',
                tooltip: 'View audit history',
                priority: 2.5,
                showInMobile: true,
                showInDesktop: true,
                requireAuth: true,
                handler: () => showNyanAuditHistoryModal()
            },
            search: {
                id: 'search',
                label: '🔍 Search',
                icon: '🔍',
                mobileIcon: '🔍',
                desktopLabel: 'Search books...',
                tooltip: 'Search messages',
                priority: 3,
                showInMobile: false, // Only in fan modal on mobile
                showInDesktop: false, // Inline search box on desktop
                requireAuth: true,
                handler: () => {
                    const searchInput = document.getElementById('searchBox');
                    if (searchInput) {
                        searchInput.focus();
                        searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }
            },
            fan: {
                id: 'fan',
                label: '🔗 All Books',
                icon: '🔗',
                mobileIcon: '🔗',
                desktopLabel: '🔗 All Books',
                tooltip: 'View all books',
                priority: 5,
                showInMobile: true,
                showInDesktop: false,
                requireAuth: true,
                handler: () => showBookFanModal()
            },
            next: {
                id: 'next',
                label: '→ Next',
                icon: '→',
                mobileIcon: '→',
                desktopLabel: '→ Next Book',
                tooltip: 'Navigate to next book',
                priority: 6,
                showInMobile: true,
                showInDesktop: false,
                requireAuth: true,
                handler: () => {
                    const activeBooks = filteredBooks.length > 0 ? filteredBooks : books;
                    if (activeBooks.length <= 1) return;
                    
                    const currentBookId = document.querySelector('.discord-messages-container')?.id?.replace('discord-messages-', '');
                    const currentIndex = activeBooks.findIndex(b => b.fractal_id === currentBookId);
                    
                    if (currentIndex !== -1) {
                        const nextIndex = currentIndex < activeBooks.length - 1 ? currentIndex + 1 : 0;
                        const nextBook = activeBooks[nextIndex];
                        if (nextBook) {
                            selectBook(nextBook.fractal_id);
                        }
                    }
                }
            }
        };
        
        /**
         * Execute action by ID with unified logic
         * Works for both mobile and desktop contexts
         */
        function executeAction(actionId, context = {}) {
            const action = ACTION_REGISTRY[actionId];
            
            if (!action) {
                console.error(`❌ Unknown action: ${actionId}`);
                return;
            }
            
            if (action.requireAuth && !currentUser) {
                showToast('⚠️ Please log in to perform this action', 'error');
                return;
            }
            
            // Execute with context
            try {
                action.handler(context);
            } catch (error) {
                console.error(`❌ Action ${actionId} failed:`, error);
                showToast(`⚠️ Action failed: ${error.message}`, 'error');
            }
        }
        
        /**
         * Get visible actions for current mode
         */
        function getVisibleActions(isMobileMode) {
            return Object.values(ACTION_REGISTRY)
                .filter(action => isMobileMode ? action.showInMobile : action.showInDesktop)
                .sort((a, b) => a.priority - b.priority);
        }

        // ===================================================================
        // MOBILE DETECTION & MODE SWITCHING
        // Now unified via LayoutController (layout-controller.js)
        // These are thin wrappers for backward compatibility
        // ===================================================================
        
        /**
         * Mobile Detection - delegates to LayoutController when available
         */
        const isMobile = () => {
            if (typeof LayoutController !== 'undefined') {
                return LayoutController.isMobile();
            }
            const aspectRatio = window.innerHeight / window.innerWidth;
            if (window.innerWidth < 768 && window.innerHeight > window.innerWidth) return true;
            if (aspectRatio > 1.4) return true;
            return false;
        };

        /**
         * Apply mobile mode - LayoutController handles this on init
         * Kept for manual triggering if needed
         */
        function applyMobileMode() {
            console.log('📱 applyMobileMode (legacy wrapper)');
            initThumbsZone();
            initPhiBreath();
        }

        /**
         * Apply desktop mode - LayoutController handles this on init
         * Kept for manual triggering if needed
         */
        function applyDesktopMode() {
            console.log('💻 applyDesktopMode (legacy wrapper)');
        }

        /**
         * Initialize thumbs zone - subscribes to LayoutController events
         */
        function initThumbsZone() {
            let thumbsZone = document.getElementById('thumbsZone');
            
            if (!thumbsZone) {
                thumbsZone = document.createElement('div');
                thumbsZone.id = 'thumbsZone';
                thumbsZone.className = 'thumbs-zone';
                document.body.appendChild(thumbsZone);
            }
            
            thumbsZone.style.display = 'flex';
            renderThumbsZone();
            console.log('🔘 Thumbs zone initialized');
        }

        // ===== φ-BREATH SINGULARITY ☯️ =====
        // Golden Ratio: The breath of truth
        // State now managed by LayoutController (layout-controller.js)
        const φ = 1.618033988749895;
        
        // LEGACY COMPAT: These now delegate to LayoutController
        // Keeping thin wrappers for backward compatibility with inline references
        const isExpanded = () => typeof LayoutController !== 'undefined' && LayoutController.isExpanded();
        const isAnimating = () => typeof LayoutController !== 'undefined' && LayoutController.isAnimating();
        
        // Animation timing constants (also in LayoutController.CONSTANTS)
        const EXPAND_DELAY = 50;
        const COLLAPSE_DELAY = 40;
        const ANIMATION_MS = 400;
        
        // φ-breath integration via LayoutController subscription
        function initPhiBreathSubscription() {
            if (typeof LayoutController === 'undefined' || typeof PHI_BREATH === 'undefined') {
                return;
            }
            
            PHI_BREATH.on('breathCycle', (data) => {
                const singularityBtn = document.querySelector('.singularity-btn');
                if (!singularityBtn || !isExpanded()) return;
                
                const φScale = data.φScale;
                const rotationDuration = 0.5 * PHI_BREATH.BASE_DURATION * φScale;
                const breathDuration = PHI_BREATH.BASE_DURATION * 0.5 * φScale;
                
                singularityBtn.style.setProperty('--rotation-duration', `${rotationDuration}ms`);
                singularityBtn.style.setProperty('--breath-duration', `${breathDuration}ms`);
            });
            
            console.log('🫁 φ-breath subscription attached to LayoutController');
        }
        
        // LEGACY: initPhiBreath now just triggers subscription setup
        function initPhiBreath() {
            initPhiBreathSubscription();
        }
        
        // Set singularity button breath animation duration
        function setBreathCycle(durationMs) {
            const singularityBtn = document.querySelector('.singularity-btn');
            if (singularityBtn) {
                singularityBtn.style.setProperty('--breath-duration', `${durationMs}ms`);
            }
        }
        
        // Get current rotation angle from computed transform matrix
        function getCurrentRotation(element) {
            const style = window.getComputedStyle(element);
            const transform = style.transform || style.webkitTransform;
            
            if (transform === 'none') {
                return 0;
            }
            
            // Parse matrix(a, b, c, d, tx, ty) or matrix3d
            const values = transform.split('(')[1].split(')')[0].split(',');
            const a = parseFloat(values[0]);
            const b = parseFloat(values[1]);
            
            // Calculate angle from transformation matrix
            // atan2(b, a) gives the rotation in radians
            const angle = Math.atan2(b, a) * (180 / Math.PI);
            
            // Normalize to 0-360 range
            return ((angle % 360) + 360) % 360;
        }
        
        /**
         * CAT BREATHE CLOCK - Single source of truth for rotation (φ∞ = 1)
         * angle = f(time) NOT f(animationState)
         * 
         * This eliminates ALL rollback bugs by deriving rotation from elapsed time,
         * not from reading unreliable CSS animation state.
         */
        const CAT_BREATHE_CLOCK = {
            startTime: performance.now(), // Eternal clock begins
            genesisCounter: 0,
            speed: 'SLOW', // 'SLOW' | 'FAST'
            locked: false,
            
            // Speed cycle durations (ms)
            cycles: {
                SLOW: 8000,  // 8 seconds per rotation
                FAST: 2000   // 2 seconds per rotation
            },
            
            // Get milliseconds into current rotation cycle
            getRotationMs() {
                const elapsed = performance.now() - this.startTime;
                const cycleMs = this.cycles[this.speed];
                return elapsed % cycleMs;
            },
            
            // Get rotation angle (0-360°) - pure function of time
            getRotationDeg() {
                const cycleMs = this.cycles[this.speed];
                const progress = this.getRotationMs() / cycleMs;
                return progress * 360;
            },
            
            // Get progress (0-1) for other animations
            getProgress() {
                const cycleMs = this.cycles[this.speed];
                return this.getRotationMs() / cycleMs;
            },
            
            // Change speed while preserving rotation continuity
            setSpeed(newSpeed) {
                if (this.speed === newSpeed || this.locked) return;
                
                this.locked = true;
                const oldSpeed = this.speed; // Capture BEFORE updating for accurate logging
                
                // 1. PRESERVE ROTATION CONTINUITY
                const currentProgress = this.getProgress();
                const newCycle = this.cycles[newSpeed];
                this.startTime = performance.now() - (currentProgress * newCycle);
                
                // 2. UPDATE SPEED
                this.speed = newSpeed;
                this.genesisCounter++;
                
                // 3. QUANTUM PURGE: Reset ALL substrate layers (breathe, pulse, radiate)
                nuclearPurge();
                
                // 4. SYNC CSS VARIABLES: Update breathe duration to match rotation speed
                const singularityBtn = document.querySelector('.singularity-btn');
                if (singularityBtn) {
                    // Match breathe timing to rotation timing
                    const breathDuration = newSpeed === 'FAST' ? 2000 : 4000;
                    singularityBtn.style.setProperty('--breath-duration', `${breathDuration}ms`);
                }
                
                // 5. LOG GENESIS (with correct old → new)
                console.log(`%c✨ GENESIS #${this.genesisCounter}: ${oldSpeed} → ${newSpeed} | progress=${(currentProgress * 100).toFixed(1)}%`, 
                    'color: #ec4899; font-weight: bold;');
                
                // Unlock after purge + sync completes
                setTimeout(() => { this.locked = false; }, 100);
            }
        };
        
        /**
         * NUCLEAR PURGE - QUANTUM BIDIRECTIONAL (horizontal + vertical)
         * Purges ALL layers: 1A (visible) + not-1A (ghost breathe/radiate/pulse)
         * 
         * Vertical: SLOW ↔ FAST
         * Horizontal: 1A symbol ↔ not-1A (core, aura, border)
         */
        function nuclearPurge() {
            const singularityBtn = document.querySelector('.singularity-btn');
            if (!singularityBtn) return;
            
            const coreEl = singularityBtn.querySelector('.core');
            const auraEl = singularityBtn.querySelector('.aura');
            
            // PURGE BREATHE layers (scale-based)
            if (coreEl) {
                coreEl.style.animation = 'none';
                coreEl.style.transform = 'scale(1)';
            }
            
            // PURGE AURA layers (pulse + opacity)
            if (auraEl) {
                auraEl.style.animation = 'none';
                auraEl.style.opacity = '0.6';
                auraEl.style.transform = 'scale(1)';
            }
            
            // Flush GPU (force reflow)
            void singularityBtn.offsetWidth;
            
            // RESURRECT animations after 16ms (1 frame)
            setTimeout(() => {
                if (coreEl) {
                    coreEl.style.animation = '';
                }
                if (auraEl) {
                    auraEl.style.animation = '';
                }
                void singularityBtn.offsetWidth;
            }, 16);
        }
        
        /**
         * RAF RENDER LOOP - 60 FPS single source of truth
         * Continuously updates rotation from time, not from animation state
         */
        let rafId = null;
        
        function renderRadiantTruth() {
            const singularityBtn = document.querySelector('.singularity-btn');
            if (!singularityBtn) {
                rafId = requestAnimationFrame(renderRadiantTruth);
                return;
            }
            
            // Get rotation from time (single truth)
            const deg = CAT_BREATHE_CLOCK.getRotationDeg();
            const progress = CAT_BREATHE_CLOCK.getProgress();
            
            // Update CSS variables (all layers read from here)
            singularityBtn.style.setProperty('--radiant-deg', `${deg}deg`);
            singularityBtn.style.setProperty('--radiant-progress', progress);
            
            // Continue eternal loop
            rafId = requestAnimationFrame(renderRadiantTruth);
        }
        
        // Start eternal rotation clock on page load
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                renderRadiantTruth();
                console.log('⏰ Radiant truth clock started (60 FPS)');
            });
        } else {
            renderRadiantTruth();
            console.log('⏰ Radiant truth clock started (60 FPS)');
        }
        
        /**
         * COLLAPSE - Now delegates to LayoutController
         * Kept as wrapper for backward compat with inline handlers
         */
        function collapseToSingularity() {
            if (typeof LayoutController !== 'undefined') {
                LayoutController.collapse();
            }
        }
        
        /**
         * EXPAND - Now delegates to LayoutController
         * Kept as wrapper for backward compat with inline handlers
         */
        function expandFromSingularity() {
            if (typeof LayoutController !== 'undefined') {
                LayoutController.expand();
            }
        }
        
        /**
         * TOGGLE - Now delegates to LayoutController
         */
        function toggleExpand() {
            if (typeof LayoutController !== 'undefined') {
                LayoutController.toggle();
            }
        }
        
        /**
         * Render thumbs zone buttons (simplified)
         * Position 1 (rightmost): Create (✍🏻) - ONLY button for genesis form
         * Position 2: Audit (🧿) - always visible
         * Position 3: Search (🔍) - desktop only (hidden on mobile - search fields are parallel to export)
         * Position 4: Book Info (📋) - ONLY shows if books > 0
         * Position 5: Book Card (🔗) - Only if 4+ books
         * Position n: Next (→) - if 2+ books
         */
        function renderThumbsZone() {
            const thumbsZone = document.getElementById('thumbsZone');
            if (!thumbsZone) return;
            
            const activeBooks = filteredBooks.length > 0 ? filteredBooks : books;
            const hasBooks = activeBooks.length > 0;
            
            console.log(`🔘 Rendering thumbs zone: ${activeBooks.length} books, hasBooks=${hasBooks}`);
            if (activeBooks.length > 0) {
                console.log(`🔘 Books:`, activeBooks.map(b => b.name));
            }
            
            const fragment = document.createDocumentFragment();
            
            const layer01 = document.createElement('div');
            layer01.className = 'layer-01';
            layer01.hidden = true;
            
            const createBtn = document.createElement('button');
            createBtn.className = 'thumb-btn';
            createBtn.dataset.action = 'create';
            createBtn.setAttribute('aria-label', 'Create new book');
            createBtn.textContent = '✍🏻';
            layer01.appendChild(createBtn);
            
            const auditBtn = document.createElement('button');
            auditBtn.className = 'thumb-btn';
            auditBtn.dataset.action = 'audit';
            auditBtn.setAttribute('aria-label', 'View audit log');
            auditBtn.textContent = '🧿';
            layer01.appendChild(auditBtn);
            
            const searchBtn = document.createElement('button');
            searchBtn.className = 'thumb-btn desktop-only';
            searchBtn.dataset.action = 'search';
            searchBtn.setAttribute('aria-label', 'Search messages');
            searchBtn.textContent = '🔍';
            layer01.appendChild(searchBtn);
            
            if (hasBooks) {
                const currentBookId = document.querySelector('.discord-messages-container')?.id?.replace('discord-messages-', '');
                const currentBook = activeBooks.find(b => b.fractal_id === currentBookId) || activeBooks[0];
                
                console.log(`🔘 Adding button 4 (🤔) for book: ${currentBook.name}`);
                const bookActionsBtn = document.createElement('button');
                bookActionsBtn.className = 'thumb-btn';
                bookActionsBtn.dataset.action = 'book-actions';
                bookActionsBtn.dataset.bookId = currentBook.fractal_id;
                bookActionsBtn.setAttribute('aria-label', 'Book actions');
                bookActionsBtn.textContent = '🤔';
                layer01.appendChild(bookActionsBtn);
            } else {
                console.log(`🔘 NO button 4 - no books found`);
            }
            
            if (activeBooks.length >= 4) {
                const fanBtn = document.createElement('button');
                fanBtn.className = 'thumb-btn';
                fanBtn.dataset.action = 'fan';
                fanBtn.setAttribute('aria-label', `All books (${activeBooks.length} total)`);
                fanBtn.textContent = '📚';
                layer01.appendChild(fanBtn);
            }
            
            fragment.appendChild(layer01);
            
            const singularityBtn = document.createElement('button');
            singularityBtn.className = 'singularity-btn';
            singularityBtn.dataset.action = 'singularity';
            singularityBtn.setAttribute('aria-label', 'Expand all actions');
            
            const core = document.createElement('span');
            core.className = 'core';
            const symbol = document.createElement('span');
            symbol.className = 'symbol';
            symbol.textContent = '☯️';
            core.appendChild(symbol);
            singularityBtn.appendChild(core);
            
            const aura = document.createElement('span');
            aura.className = 'aura';
            singularityBtn.appendChild(aura);
            
            fragment.appendChild(singularityBtn);
            
            thumbsZone.replaceChildren(fragment);
            console.log(`🔘 Thumbs zone rendered with SafeDOM`);
            
            if (isMobile() && typeof PHI_BREATH !== 'undefined') {
                setBreathCycle(PHI_BREATH.BASE_DURATION);
            }
        }

        /**
         * Initialize layout detection - now delegates to LayoutController
         * LayoutController handles resize/orientation events internally
         */
        function initMobileDetection() {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const ar = (h / w).toFixed(2);
            console.log(`📐 Screen: ${w}x${h}px (aspect ratio: ${ar})`);
            
            if (typeof LayoutController !== 'undefined') {
                LayoutController.subscribe((event, data) => {
                    if (event === 'thumbsZoneReady') {
                        renderThumbsZone();
                    }
                    if (event === 'deviceChanged') {
                        console.log(`📐 LayoutController: device changed to ${data.device}`);
                        if (data.device === 'mobile') {
                            initThumbsZone();
                            initPhiBreath();
                        }
                    }
                });
                
                LayoutController.init();
                
                if (LayoutController.isMobile()) {
                    initThumbsZone();
                    initPhiBreath();
                }
                
                console.log('📐 LayoutController initialized');
            } else {
                if (isMobile()) {
                    applyMobileMode();
                } else {
                    applyDesktopMode();
                }
            }
        }

        /**
         * Initialize touch interactions for mobile (iPhone-optimized)
         * φ12: Touch is truth. Built for fingers.
         */
        function initTouchInteractions() {
            // TAP-TO-ZOOM: Media images
            document.addEventListener('click', function(e) {
                const img = e.target.closest('.discord-media-preview img, .message img');
                if (img && isMobile()) {
                    e.preventDefault();
                    openFullScreenMedia(img.src);
                }
            });
            
            // SWIPE NAVIGATION: Left/right to switch books
            let touchStartX = 0;
            let touchStartY = 0;
            let touchStartTime = 0;
            let isScrolling = false;
            
            const messageContainer = document.getElementById('bookDetail');
            
            if (messageContainer) {
                messageContainer.addEventListener('touchstart', function(e) {
                    if (!isMobile()) return;
                    if (e.target.closest('.modal, .thumbs-zone, input, textarea, button')) return;
                    
                    const touch = e.touches[0];
                    touchStartX = touch.clientX;
                    touchStartY = touch.clientY;
                    touchStartTime = Date.now();
                    isScrolling = false;
                }, { passive: true });
                
                messageContainer.addEventListener('touchmove', function(e) {
                    if (!touchStartX || !touchStartY) return;
                    
                    const touch = e.touches[0];
                    const deltaX = Math.abs(touch.clientX - touchStartX);
                    const deltaY = Math.abs(touch.clientY - touchStartY);
                    
                    // Detect vertical scroll vs horizontal swipe
                    if (deltaY > deltaX) {
                        isScrolling = true;
                    }
                }, { passive: true });
                
                messageContainer.addEventListener('touchend', function(e) {
                    if (!isMobile() || isScrolling) return;
                    if (!touchStartX || e.target.closest('.modal, .thumbs-zone')) return;
                    
                    const touch = e.changedTouches[0];
                    const deltaX = touch.clientX - touchStartX;
                    const deltaY = touch.clientY - touchStartY;
                    const deltaTime = Date.now() - touchStartTime;
                    
                    // Horizontal swipe must be dominant and quick
                    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.5 && 
                        Math.abs(deltaX) > 100 && 
                        deltaTime < 500) {
                        
                        const activeBooks = filteredBooks.length > 0 ? filteredBooks : books;
                        if (activeBooks.length <= 1) return;
                        
                        const currentBookId = document.querySelector('.discord-messages-container')?.id?.replace('discord-messages-', '');
                        const currentIndex = activeBooks.findIndex(b => b.fractal_id === currentBookId);
                        
                        if (currentIndex === -1) return;
                        
                        // Swipe RIGHT = PREVIOUS, Swipe LEFT = NEXT
                        let nextIndex;
                        if (deltaX > 0) {
                            nextIndex = currentIndex > 0 ? currentIndex - 1 : activeBooks.length - 1;
                        } else {
                            nextIndex = currentIndex < activeBooks.length - 1 ? currentIndex + 1 : 0;
                        }
                        
                        const nextBook = activeBooks[nextIndex];
                        if (nextBook) {
                            selectBook(nextBook.fractal_id);
                            showToast(`📱 ${nextBook.name}`, 'info');
                        }
                    }
                    
                    // Reset
                    touchStartX = 0;
                    touchStartY = 0;
                    isScrolling = false;
                }, { passive: true });
            }
            
            // AUTO-HIDE THUMBS ZONE on scroll
            let lastScrollY = 0;
            let scrollTimeout;
            
            window.addEventListener('scroll', function() {
                if (!isMobile()) return;
                
                const thumbsZone = document.getElementById('thumbsZone');
                if (!thumbsZone) return;
                
                const currentScrollY = window.scrollY;
                
                clearTimeout(scrollTimeout);
                
                // Hide on scroll down, show on scroll up
                if (currentScrollY > lastScrollY && currentScrollY > 100) {
                    thumbsZone.style.transform = 'translateY(100px)';
                    thumbsZone.style.opacity = '0';
                } else {
                    thumbsZone.style.transform = 'translateY(0)';
                    thumbsZone.style.opacity = '1';
                }
                
                lastScrollY = currentScrollY;
                
                // Show again after scroll stops
                scrollTimeout = setTimeout(() => {
                    thumbsZone.style.transform = 'translateY(0)';
                    thumbsZone.style.opacity = '1';
                }, 150);
            }, { passive: true });
        }
        
        /**
         * Full-screen media modal (iPhone-optimized)
         */
        function openFullScreenMedia(src) {
            const modal = document.createElement('div');
            modal.id = 'fullScreenMediaModal';
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: #000;
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: fadeIn 0.2s ease;
            `;
            
            const img = document.createElement('img');
            img.src = src;
            img.style.cssText = 'max-width: 95vw; max-height: 95vh; border-radius: 12px; object-fit: contain;';
            modal.appendChild(img);
            
            const closeBtn = document.createElement('button');
            closeBtn.className = 'media-close-btn';
            closeBtn.style.cssText = 'position: absolute; top: 20px; right: 20px; width: 44px; height: 44px; background: rgba(0,0,0,0.7); color: white; border: none; border-radius: 50%; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);';
            closeBtn.textContent = '×';
            modal.appendChild(closeBtn);
            
            document.body.appendChild(modal);
            
            modal.addEventListener('click', function(e) {
                if (e.target === modal || e.target.classList.contains('media-close-btn')) {
                    modal.style.animation = 'fadeOut 0.2s ease';
                    setTimeout(() => modal.remove(), 200);
                }
            });
        }

        // HTML sanitization to prevent XSS attacks
        function escapeHtml(unsafe) {
            if (!unsafe) return '';
            return String(unsafe)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        // Normalize a single media element to ensure container query constraints apply
        function normalizeMediaElement(el) {
            if (!el) return;
            const tagName = el.tagName.toLowerCase();
            
            if (tagName === 'img') {
                // Skip avatar images
                if (el.classList.contains('avatar-photo')) return;
                if (el.classList.contains('media-blur-placeholder')) return;
                
                // Add the constraining class if not present
                if (!el.classList.contains('discord-media-image')) {
                    el.classList.add('discord-media-image');
                }
                
                // Remove conflicting inline styles
                el.style.removeProperty('max-width');
                el.style.removeProperty('max-height');
                el.style.removeProperty('width');
                el.style.removeProperty('height');
            } else if (tagName === 'video') {
                if (!el.classList.contains('discord-media-video')) {
                    el.classList.add('discord-media-video');
                }
                el.style.removeProperty('max-width');
                el.style.removeProperty('max-height');
                el.style.removeProperty('width');
                el.style.removeProperty('height');
            }
        }
        
        // Normalize all media images in a container
        function normalizeMediaImages(container) {
            if (!container) return;
            
            // Find all images inside embeds or attachments that aren't avatars
            const mediaImages = container.querySelectorAll('.discord-embed img, .discord-attachment img, .discord-media-preview img, .media-progressive-container img');
            mediaImages.forEach(normalizeMediaElement);
            
            // Same for videos
            const mediaVideos = container.querySelectorAll('.discord-embed video, .discord-attachment video, .discord-media-preview video');
            mediaVideos.forEach(normalizeMediaElement);
        }
        
        // MutationObserver to auto-normalize media as it's added or modified in DOM
        const mediaNormalizer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                // Handle newly added nodes
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType !== Node.ELEMENT_NODE) return;
                        
                        // Check if it's a media element itself
                        if (node.tagName === 'IMG' || node.tagName === 'VIDEO') {
                            // Only normalize if inside a message container
                            if (node.closest('.discord-messages-container')) {
                                normalizeMediaElement(node);
                            }
                        }
                        
                        // Check for media elements inside the added node
                        if (node.querySelectorAll) {
                            const imgs = node.querySelectorAll('img');
                            const videos = node.querySelectorAll('video');
                            imgs.forEach(img => {
                                if (img.closest('.discord-messages-container')) {
                                    normalizeMediaElement(img);
                                }
                            });
                            videos.forEach(video => {
                                if (video.closest('.discord-messages-container')) {
                                    normalizeMediaElement(video);
                                }
                            });
                        }
                    });
                }
                
                // Handle attribute changes (src swaps, style changes)
                if (mutation.type === 'attributes') {
                    const target = mutation.target;
                    if (target.tagName === 'IMG' || target.tagName === 'VIDEO') {
                        if (target.closest('.discord-messages-container')) {
                            // Re-normalize on attribute changes to catch lazy-load src swaps
                            normalizeMediaElement(target);
                        }
                    }
                }
            });
        });
        
        // Start observing the document for media additions and attribute changes
        mediaNormalizer.observe(document.body, { 
            childList: true, 
            subtree: true, 
            attributes: true, 
            attributeFilter: ['src', 'style'] 
        });

        // Check authentication on page load (uses global window.authFetch)
        async function checkAuth() {
            try {
                const res = await window.authFetch('/api/auth/status');
                const data = await res.json();

                if (res.status === 503 && data.code === 'warming_up') {
                    const userInfo = document.getElementById('userInfo');
                    if (userInfo) userInfo.textContent = '🐱 warming up...';
                    let overlay = document.getElementById('nyanWarmupOverlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.id = 'nyanWarmupOverlay';
                        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(10,14,28,0.92);backdrop-filter:blur(6px);';
                        const cat = document.createElement('div');
                        cat.style.cssText = 'font-size:3rem;margin-bottom:1rem;animation:pulse 1.5s ease-in-out infinite;';
                        cat.textContent = '🐱';
                        const msg = document.createElement('p');
                        msg.style.cssText = 'margin:0;color:#a855f7;font-size:1rem;letter-spacing:0.02em;';
                        msg.textContent = 'Warming up — retrying in 5 seconds...';
                        overlay.appendChild(cat);
                        overlay.appendChild(msg);
                        document.body.appendChild(overlay);
                    }
                    setTimeout(() => checkAuth(), 5000);
                    return false;
                }
                const existing = document.getElementById('nyanWarmupOverlay');
                if (existing) existing.remove();

                if (!data.authenticated) {
                    window.location.href = '/login.html';
                    return false;
                }
                
                setCurrentUser(data.user);
                const userInfo = document.getElementById('userInfo');
                const roleColors = {
                    'dev': '#ffffff',
                    'admin': '#10b981',
                    'user': '#60a5fa',
                    'read-only': '#f59e0b',
                    'write-only': '#3b82f6'
                };
                
                function renderUserInfo(isGenesis = false) {
                    const span = document.createElement('span');
                    span.style.cssText = `color: ${roleColors[currentUser.role] || '#94a3b8'}; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.4;`;
                    
                    const emailSpan = document.createElement('span');
                    emailSpan.textContent = `● ${currentUser.email || currentUser.phone}`;
                    span.appendChild(emailSpan);
                    
                    const roleSpan = document.createElement('span');
                    roleSpan.style.cssText = 'font-size: 0.85em; opacity: 0.9;';
                    roleSpan.textContent = isGenesis ? `(${currentUser.role}) 🌟 Genesis` : `(${currentUser.role})`;
                    span.appendChild(roleSpan);
                    
                    userInfo.replaceChildren(span);
                }
                
                renderUserInfo(false);
                
                const devTab = document.getElementById('devPanelBtn');
                const usersTabBtn = document.getElementById('usersTabBtn');
                
                const isGenesisAdmin = currentUser.isGenesisAdmin || currentUser.is_genesis_admin;
                
                if (currentUser.role === 'dev' || isGenesisAdmin) {
                    if (devTab) devTab.style.display = 'block';
                    if (usersTabBtn) usersTabBtn.style.display = 'block';
                    
                    if (isGenesisAdmin) {
                        renderUserInfo(true);
                    }
                } else if (currentUser.role === 'admin') {
                    if (usersTabBtn) usersTabBtn.style.display = 'block';
                }
                
                return true;
            } catch (error) {
                window.location.href = '/login.html';
                return false;
            }
        }
        
        // Logout function (Safari/iOS compatible)
        async function logout() {
            console.log('🔓 Logging out...');
            
            try {
                await window.authFetch('/api/auth/logout', { method: 'POST' });
            } catch (error) {
                console.error('Logout API error:', error);
            }
            
            // SECURITY: Clear all cached data to prevent cross-session data leakage
            setMessageCache({});
            setAllMessages({});
            setBooks([]);
            setFilteredBooks([]);
            
            // Clear JWT tokens from localStorage (Safari-safe)
            try {
                localStorage.removeItem('accessToken');
                localStorage.removeItem('refreshToken');
                localStorage.clear(); // Clear all localStorage for Safari
                sessionStorage.clear(); // Clear sessionStorage too
                console.log('✅ Cleared localStorage and sessionStorage');
            } catch (e) {
                console.log('⚠️ Storage clear error (Safari private mode?):', e);
            }
            
            // CRITICAL: Delete ALL cookies (Safari/iPhone compatible)
            document.cookie.split(";").forEach(function(c) { 
                document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
            });
            console.log('✅ Cleared all cookies');
            
            // Force redirect after short delay for Safari
            console.log('🔄 Redirecting to login page...');
            setTimeout(() => {
                window.location.replace('/login.html'); // Use replace instead of href
            }, 100);
        }
        
        // Tag Management Functions for Bubble UI
        function addTagOnEnter(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                const input = document.getElementById('botTagsInput');
                const tag = input.value.trim();
                
                if (tag && !botTags.includes(tag)) {
                    botTags.push(tag);
                    renderTags();
                    input.value = '';
                }
            }
        }

        function removeTag(tag) {
            setBotTags(botTags.filter(t => t !== tag));
            renderTags();
        }

        function renderTags() {
            const container = document.getElementById('tagContainer');
            const input = document.getElementById('botTagsInput');
            
            while (container.firstChild) {
                container.removeChild(container.firstChild);
            }
            
            botTags.forEach(tag => {
                const bubble = document.createElement('div');
                bubble.className = 'tag-bubble';
                bubble.appendChild(document.createTextNode(tag));
                
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'tag-remove';
                removeBtn.dataset.tag = tag;
                removeBtn.textContent = '×';
                bubble.appendChild(removeBtn);
                
                container.appendChild(bubble);
            });
            
            container.appendChild(input);
        }

        // Webhook Management Functions for 1-to-Many Output
        function addWebhookInput() {
            const webhookId = Date.now();
            botWebhooks.push({ id: webhookId, url: '', name: '' });
            renderWebhooks();
        }

        function removeWebhook(webhookId) {
            setBotWebhooks(botWebhooks.filter(w => w.id !== webhookId));
            renderWebhooks();
        }

        function updateWebhook(webhookId, field, value) {
            const webhook = botWebhooks.find(w => w.id === webhookId);
            if (webhook) {
                webhook[field] = value;
            }
        }

        function renderWebhooks() {
            const container = document.getElementById('webhooksList');
            const fragment = document.createDocumentFragment();
            
            botWebhooks.forEach(webhook => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center;';
                
                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.className = 'form-input';
                nameInput.placeholder = 'Webhook Name (e.g., Main Channel)';
                nameInput.value = webhook.name;
                nameInput.dataset.webhookId = webhook.id;
                nameInput.dataset.webhookField = 'name';
                nameInput.style.cssText = 'flex: 0 0 30%;';
                row.appendChild(nameInput);
                
                const urlInput = document.createElement('input');
                urlInput.type = 'url';
                urlInput.className = 'form-input';
                urlInput.placeholder = 'https://discord.com/api/webhooks/... or any webhook URL';
                urlInput.value = webhook.url;
                urlInput.dataset.webhookId = webhook.id;
                urlInput.dataset.webhookField = 'url';
                urlInput.style.cssText = 'flex: 1;';
                row.appendChild(urlInput);
                
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'btn';
                removeBtn.dataset.removeWebhook = webhook.id;
                removeBtn.style.cssText = 'background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; padding: 0.5rem 1rem;';
                removeBtn.textContent = '×';
                row.appendChild(removeBtn);
                
                fragment.appendChild(row);
            });
            
            container.replaceChildren(fragment);
        }

        // ── Outpipes Management ──────────────────────────────────────────────────
        // State: typed outpipe configs {type, name, url?, to?, secret?} per book
        let userOutpipes = [];

        function renderOutpipes() {
            const container = document.getElementById('outpipesList');
            if (!container) return;
            container.replaceChildren();

            const TYPE_LABELS = { discord: '🔷 Discord', email: '📧 Email', webhook: '🔗 Webhook' };
            const TYPE_PLACEHOLDER = {
                discord: 'https://discord.com/api/webhooks/…',
                email: 'you@example.com',
                webhook: 'https://yourapp.com/hook'
            };

            userOutpipes.forEach((pipe, idx) => {
                const row = document.createElement('div');
                row.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 0.6rem 0.75rem; margin-bottom: 0.4rem;';

                // Row 1: type selector + name + remove
                const top = document.createElement('div');
                top.style.cssText = 'display: flex; gap: 0.4rem; align-items: center; margin-bottom: 0.4rem;';

                const typeSelect = document.createElement('select');
                typeSelect.className = 'form-select';
                typeSelect.style.cssText = 'flex: 0 0 auto; width: 130px; padding: 0.35rem 0.5rem; font-size: 0.8rem;';
                ['discord', 'email', 'webhook'].forEach(t => {
                    const opt = document.createElement('option');
                    opt.value = t;
                    opt.textContent = TYPE_LABELS[t];
                    if (pipe.type === t) opt.selected = true;
                    typeSelect.appendChild(opt);
                });
                typeSelect.addEventListener('change', e => {
                    userOutpipes[idx] = { ...userOutpipes[idx], type: e.target.value, url: '', to: '' };
                    renderOutpipes();
                });
                top.appendChild(typeSelect);

                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.className = 'form-input';
                nameInput.placeholder = 'Label (e.g., My Server)';
                nameInput.value = pipe.name || '';
                nameInput.style.cssText = 'flex: 1; padding: 0.35rem 0.5rem; font-size: 0.8rem;';
                nameInput.addEventListener('input', e => { userOutpipes[idx].name = e.target.value; });
                top.appendChild(nameInput);

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.textContent = '×';
                removeBtn.style.cssText = 'background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; border-radius: 6px; padding: 0.35rem 0.6rem; cursor: pointer; font-size: 0.9rem;';
                removeBtn.addEventListener('click', () => { userOutpipes.splice(idx, 1); renderOutpipes(); });
                top.appendChild(removeBtn);
                row.appendChild(top);

                // Row 2: URL or email field
                const valueInput = document.createElement('input');
                valueInput.className = 'form-input';
                valueInput.style.cssText = 'width: 100%; padding: 0.35rem 0.5rem; font-size: 0.8rem; box-sizing: border-box;';
                if (pipe.type === 'email') {
                    valueInput.type = 'email';
                    valueInput.placeholder = TYPE_PLACEHOLDER.email;
                    valueInput.value = pipe.to || '';
                    valueInput.addEventListener('input', e => { userOutpipes[idx].to = e.target.value; });
                } else {
                    valueInput.type = 'url';
                    valueInput.placeholder = TYPE_PLACEHOLDER[pipe.type] || 'https://…';
                    valueInput.value = pipe.url || '';
                    valueInput.addEventListener('input', e => { userOutpipes[idx].url = e.target.value; });
                }
                row.appendChild(valueInput);

                const TYPE_HINTS = {
                    discord: 'Discord: Server Settings → Integrations → Webhooks → Copy URL',
                    webhook: 'Any HTTPS endpoint that accepts POST requests',
                    email: ''
                };
                if (TYPE_HINTS[pipe.type]) {
                    const hint = document.createElement('div');
                    hint.style.cssText = 'color: #64748b; font-size: 0.65rem; margin-top: 0.25rem; line-height: 1.3;';
                    hint.textContent = TYPE_HINTS[pipe.type];
                    row.appendChild(hint);
                }

                container.appendChild(row);
            });
        }

        async function saveOutpipes() {
            const bookId = editingBookId;
            if (!bookId) return;

            const outpipes = userOutpipes.map(p => {
                const cfg = { type: p.type, name: p.name || p.type };
                if (p.type === 'email') { cfg.to = (p.to || '').trim(); }
                else { cfg.url = (p.url || '').trim(); }
                if (p.type === 'webhook' && p.secret) cfg.secret = p.secret;
                return cfg;
            }).filter(p => (p.type === 'email' ? p.to : p.url));

            const hasUrlOutpipe = outpipes.some(p => p.type === 'discord' || p.type === 'webhook');
            let password = null;
            if (hasUrlOutpipe) {
                password = await showPasswordModal('Enter your account password to save Discord / Webhook channels.');
                if (!password) return;
            }

            const btn = document.getElementById('saveOutpipesBtn');
            btn.textContent = 'Saving…';
            btn.disabled = true;

            try {
                const res = await fetch(`/api/books/${bookId}/outpipes`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                    body: JSON.stringify({ outpipes, ...(password ? { password } : {}) })
                });
                const data = await res.json();
                if (!res.ok) {
                    showToast(data.error || 'Failed to save channels', 'error');
                } else {
                    showToast(`${outpipes.length} output channel(s) saved`, 'success');
                    const book = books.find(b => b.fractal_id === bookId);
                    if (book) book.outpipes_user = data.outpipes_user;
                }
            } catch (e) {
                showToast('Network error saving channels', 'error');
            } finally {
                btn.textContent = 'Save Channels';
                btn.disabled = false;
            }
        }

        function _showBookSkeletons() {
            const sidebar = document.getElementById('bookListContainer');
            if (!sidebar) return;
            const frag = document.createDocumentFragment();
            for (let i = 0; i < 4; i++) {
                const item = document.createElement('div');
                item.className = 'book-skeleton-item';
                const wrap = document.createElement('div');
                wrap.style.cssText = 'flex:1;min-width:0;';
                const nameLine = document.createElement('div');
                nameLine.className = 'sk-line sk-name';
                nameLine.style.animationDelay = `${i * 0.15}s`;
                const countLine = document.createElement('div');
                countLine.className = 'sk-line sk-count';
                countLine.style.animationDelay = `${i * 0.15 + 0.08}s`;
                wrap.appendChild(nameLine);
                wrap.appendChild(countLine);
                item.appendChild(wrap);
                frag.appendChild(item);
            }
            sidebar.replaceChildren(frag);
        }

        function _showMsgLoader(bookId) {
            const container = document.getElementById(`discord-messages-${bookId}`);
            if (!container) return;
            container.innerHTML = '';
            const loader = document.createElement('div');
            loader.className = 'nyan-msg-loader';
            const ring = document.createElement('div');
            ring.className = 'loader-ring';
            const label = document.createElement('div');
            label.textContent = 'Loading messages\u2026';
            loader.appendChild(ring);
            loader.appendChild(label);
            container.appendChild(loader);
        }

        let selectedBookFractalId = null;
        let _priorityBookLoaded = false;

        function _persistSelectedBook(fractalId, bookName) {
            try {
                localStorage.setItem('nyan_lastBook', fractalId);
                if (bookName) localStorage.setItem('nyan_lastBookName', bookName);
            } catch (_) {}
        }

        function _readCachedBook() {
            try {
                return {
                    id: localStorage.getItem('nyan_lastBook'),
                    name: localStorage.getItem('nyan_lastBookName')
                };
            } catch (_) { return { id: null, name: null }; }
        }

        let _detailShellReady = false;

        function _buildDetailShell() {
            const detail = document.getElementById('bookDetail');
            if (!detail || _detailShellReady) return;
            _detailShellReady = true;

            const headerBar = document.createElement('div');
            headerBar.id = 'detail-header';
            headerBar.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.75rem; background: rgba(30, 41, 59, 0.6); border-bottom: 1px solid rgba(148, 163, 184, 0.1);';

            const headerLeft = document.createElement('div');
            headerLeft.style.cssText = 'display: flex; align-items: center; gap: 0.75rem; flex: 1; min-width: 0;';
            const nameEl = document.createElement('div');
            nameEl.id = 'detail-book-name';
            nameEl.style.cssText = 'color: #e2e8f0; font-weight: 600; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
            nameEl.textContent = '\u00A0';
            headerLeft.appendChild(nameEl);
            const statusSlot = document.createElement('span');
            statusSlot.id = 'detail-wa-status';
            statusSlot.style.cssText = 'display: none;';
            headerLeft.appendChild(statusSlot);
            headerBar.appendChild(headerLeft);

            const headerRight = document.createElement('div');
            headerRight.id = 'detail-header-btns';
            headerRight.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';
            const createIconBtn = (dataAttr, title, bgColor, textColor, icon) => {
                const btn = document.createElement('button');
                btn.className = 'btn-icon';
                btn.dataset[dataAttr] = '';
                btn.title = title;
                btn.style.cssText = `background: ${bgColor}; color: ${textColor}; border: none; padding: 0.375rem 0.5rem; border-radius: 4px; cursor: pointer; font-size: 0.875rem;`;
                btn.textContent = icon;
                return btn;
            };
            headerRight.appendChild(createIconBtn('showBookInfo', 'Book Information', 'rgba(148, 163, 184, 0.15)', '#94a3b8', 'ℹ️'));
            if (!isDevPanelView) {
                const waBtn = createIconBtn('showWhatsappActivation', 'WhatsApp Activation', 'rgba(34, 197, 94, 0.15)', '#22c55e', '📱');
                waBtn.id = 'detail-wa-btn';
                waBtn.style.cssText += 'display: none;';
                headerRight.appendChild(waBtn);
                headerRight.appendChild(createIconBtn('editBook', 'Edit', 'rgba(251, 191, 36, 0.15)', '#fbbf24', '✏️'));
                headerRight.appendChild(createIconBtn('downloadEntireBook', 'Download Entire Book', 'rgba(34, 197, 94, 0.15)', '#22c55e', '⬇️'));
                headerRight.appendChild(createIconBtn('deleteBook', 'Delete', 'rgba(239, 68, 68, 0.15)', '#ef4444', '🗑️'));
            }
            headerBar.appendChild(headerRight);

            const activationSlot = document.createElement('div');
            activationSlot.id = 'detail-activation';
            activationSlot.style.cssText = 'display: none;';

            const toolbar = document.createElement('div');
            toolbar.id = 'detail-toolbar';
            toolbar.style.cssText = 'display: flex; gap: 0.3rem; padding: 0.3rem 0.5rem; background: rgba(30, 41, 59, 0.4); border-radius: 6px; margin-bottom: 0.375rem; flex-shrink: 0; align-items: center;';

            const selectAllLabel = document.createElement('label');
            selectAllLabel.style.cssText = 'display: flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0; font-size: 0.75rem; cursor: pointer; white-space: nowrap; flex-shrink: 0;';
            const selectAllCheckbox = document.createElement('input');
            selectAllCheckbox.type = 'checkbox';
            selectAllCheckbox.id = 'detail-select-all';
            selectAllCheckbox.style.cssText = 'cursor: pointer;';
            selectAllLabel.appendChild(selectAllCheckbox);
            selectAllLabel.appendChild(document.createTextNode('All'));
            toolbar.appendChild(selectAllLabel);

            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.id = 'detail-msg-search';
            searchInput.placeholder = '\uD83D\uDD0D Search...';
            searchInput.style.cssText = 'padding: 0.25rem 0.5rem; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0; font-size: 0.8rem; flex: 1 1 80px; min-width: 60px;';
            toolbar.appendChild(searchInput);

            const statusSelect = document.createElement('select');
            statusSelect.id = 'detail-status-filter';
            statusSelect.style.cssText = 'padding: 0.25rem 0.375rem; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0; font-size: 0.75rem; flex-shrink: 0;';
            [['all', 'All'], ['success', '\u2713'], ['failed', '\u2717']].forEach(([val, txt]) => {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = txt;
                statusSelect.appendChild(opt);
            });
            toolbar.appendChild(statusSelect);

            const downloadBtn = document.createElement('button');
            downloadBtn.id = 'detail-download-sel';
            downloadBtn.disabled = true;
            downloadBtn.style.cssText = 'padding: 0.25rem 0.5rem; background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 0.375rem; color: #22c55e; font-size: 0.7rem; cursor: pointer; white-space: nowrap; opacity: 0.5; flex-shrink: 0;';
            downloadBtn.textContent = '\u2B07\uFE0F Attachment';
            toolbar.appendChild(downloadBtn);

            const tagBtn = document.createElement('button');
            tagBtn.id = 'detail-tag-sel';
            tagBtn.disabled = true;
            tagBtn.style.cssText = 'padding: 0.25rem 0.5rem; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 0.375rem; color: #a855f7; font-size: 0.7rem; cursor: pointer; white-space: nowrap; opacity: 0.5; flex-shrink: 0;';
            tagBtn.textContent = '\uD83C\uDFF7\uFE0F Tag';
            toolbar.appendChild(tagBtn);

            const searchIndicator = document.createElement('div');
            searchIndicator.id = 'detail-search-indicator';
            searchIndicator.style.cssText = 'display: none; background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 0.375rem; padding: 0.25rem 0.5rem; font-size: 0.75rem; color: #22c55e; align-items: center; gap: 0.5rem; justify-content: space-between; margin-bottom: 0.5rem; flex-shrink: 0;';
            const indicatorText = document.createElement('span');
            indicatorText.textContent = '\uD83D\uDD0D Filtered from book search';
            searchIndicator.appendChild(indicatorText);
            const clearBtn = document.createElement('button');
            clearBtn.id = 'detail-clear-filter';
            clearBtn.style.cssText = 'background: none; border: none; color: #22c55e; cursor: pointer; font-size: 1.25rem; padding: 0; line-height: 1; font-weight: bold;';
            clearBtn.title = 'Clear filter';
            clearBtn.textContent = '\u00D7';
            searchIndicator.appendChild(clearBtn);

            const messagesWrapper = document.createElement('div');
            messagesWrapper.id = 'detail-messages-wrapper';
            messagesWrapper.style.cssText = 'display: flex; flex-direction: column; flex: 1; margin-top: 0.5rem; min-height: 0;';
            messagesWrapper.appendChild(toolbar);
            messagesWrapper.appendChild(searchIndicator);

            const msgContainer = document.createElement('div');
            msgContainer.id = 'detail-msg-container';
            msgContainer.className = 'discord-messages-container';
            msgContainer.style.cssText = 'flex: 1; overflow-y: auto; background: rgba(30, 41, 59, 0.3); border-radius: 6px; padding: 0.75rem; min-height: 0;';
            messagesWrapper.appendChild(msgContainer);

            detail.replaceChildren(headerBar, activationSlot, messagesWrapper);
        }

        let _boundBookId = null;

        function _bindShellToBook(fractalId, bookName) {
            const prev = _boundBookId;
            _boundBookId = fractalId;

            const nameEl = document.getElementById('detail-book-name');
            if (nameEl) nameEl.textContent = bookName || fractalId;

            const statusSlot = document.getElementById('detail-wa-status');
            if (statusSlot) { statusSlot.style.display = 'none'; statusSlot.textContent = ''; }

            const btns = document.getElementById('detail-header-btns');
            if (btns) {
                btns.querySelectorAll('[data-show-book-info]').forEach(b => b.dataset.showBookInfo = fractalId);
                btns.querySelectorAll('[data-show-whatsapp-activation]').forEach(b => b.dataset.showWhatsappActivation = fractalId);
                btns.querySelectorAll('[data-edit-book]').forEach(b => b.dataset.editBook = fractalId);
                btns.querySelectorAll('[data-download-entire-book]').forEach(b => b.dataset.downloadEntireBook = fractalId);
                btns.querySelectorAll('[data-delete-book]').forEach(b => b.dataset.deleteBook = fractalId);
            }

            const remap = [
                ['select-all', prev ? `select-all-${prev}` : 'detail-select-all', `select-all-${fractalId}`, 'selectAll'],
                ['msg-search', prev ? `msg-search-${prev}` : 'detail-msg-search', `msg-search-${fractalId}`, 'filterMessages'],
                ['status-filter', prev ? `status-filter-${prev}` : 'detail-status-filter', `status-filter-${fractalId}`, 'statusFilter'],
                ['download-selected', prev ? `download-selected-${prev}` : 'detail-download-sel', `download-selected-${fractalId}`, 'downloadBook'],
                ['tag-selected', prev ? `tag-selected-${prev}` : 'detail-tag-sel', `tag-selected-${fractalId}`, 'tagBook'],
                ['search-indicator', prev ? `search-indicator-${prev}` : 'detail-search-indicator', `search-indicator-${fractalId}`, null],
                ['discord-messages', prev ? `discord-messages-${prev}` : 'detail-msg-container', `discord-messages-${fractalId}`, null],
            ];

            remap.forEach(([, oldId, newId, dataKey]) => {
                const el = document.getElementById(oldId);
                if (!el) return;
                el.id = newId;
                if (dataKey) el.dataset[dataKey] = fractalId;
            });

            const cf = prev
                ? document.querySelector(`[data-clear-filter="${prev}"]`)
                : document.getElementById('detail-clear-filter');
            if (cf) { cf.removeAttribute('id'); cf.dataset.clearFilter = fractalId; }
        }

        function _updateShellVisibility(book) {
            if (!book) return;
            const platform = (book.input_platform || book.platform || '').toLowerCase();
            const waBtn = document.getElementById('detail-wa-btn');
            if (waBtn) waBtn.style.display = (platform === 'whatsapp') ? 'inline-flex' : 'none';

            const editBtns = document.querySelectorAll('#detail-header-btns [data-edit-book]');
            const delBtns = document.querySelectorAll('#detail-header-btns [data-delete-book]');
            editBtns.forEach(b => b.style.display = book.canEdit ? '' : 'none');
            delBtns.forEach(b => b.style.display = book.canEdit ? '' : 'none');
        }

        let _backgroundBooksDone = false;

        async function _initPriorityLoad() {
            const cached = _readCachedBook();
            const fidParam = cached.id ? `?fid=${encodeURIComponent(cached.id)}` : '';
            try {
                const resp = await window.authFetch(`/api/books/top${fidParam}`);
                if (!resp.ok) return;
                const data = await resp.json();
                const topBook = data.book;
                if (!topBook) return;

                if (_backgroundBooksDone) return;

                selectedBookFractalId = topBook.fractal_id;
                _persistSelectedBook(topBook.fractal_id, topBook.name);
                _bindShellToBook(topBook.fractal_id, topBook.name);
                _updateShellVisibility(topBook);

                if (isMobile()) {
                    const bookSidebar = document.getElementById('bookSidebar');
                    const bookDetail = document.getElementById('bookDetail');
                    if (bookSidebar) bookSidebar.style.display = 'none';
                    if (bookDetail) bookDetail.style.display = 'flex';
                }

                messagePageState[topBook.fractal_id] = { isLoading: false, hasOlder: true, seenIds: new Set(), oldestId: null };
                await loadBookMessages(topBook.fractal_id, false);
                _priorityBookLoaded = true;
                startPolling(topBook.fractal_id);
            } catch (err) {
                console.error('Priority load failed:', err);
            }
        }

        async function _initBackgroundBooks() {
            _showBookSkeletons();
            const result = await _B.loadBooks(true);
            if (!result.success) return;
            books = _S.getBooks();
            filteredBooks = _S.getFilteredBooks();
            _backgroundBooksDone = true;

            if (_priorityBookLoaded && filteredBooks.find(b => b.fractal_id === selectedBookFractalId)) {
                renderBooks(true);
                const book = filteredBooks.find(b => b.fractal_id === selectedBookFractalId);
                _updateShellVisibility(book);
                _fetchWhatsAppStatus(book);
            } else if (_priorityBookLoaded) {
                localStorage.removeItem('nyan_lastBook');
                localStorage.removeItem('nyan_lastBookName');
                selectedBookFractalId = filteredBooks.length ? filteredBooks[0].fractal_id : null;
                renderBooks();
            } else {
                renderBooks();
            }
            updatePlatformFilter();
            if (isMobile()) renderThumbsZone();
        }

        async function _fetchWhatsAppStatus(book) {
            if (!book) return;
            const platform = (book.input_platform || book.platform || '').toLowerCase();
            if (platform !== 'whatsapp') return;
            try {
                const resp = await window.authFetch(`/api/books/${book.fractal_id}/status`);
                if (!resp.ok) return;
                const whatsappStatus = await resp.json();
                const slot = document.getElementById('detail-wa-status');
                if (slot) {
                    slot.style.cssText = `background: ${whatsappStatus.status === 'ready' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(251, 191, 36, 0.2)'}; color: ${whatsappStatus.status === 'ready' ? '#10b981' : '#fbbf24'}; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; display: inline;`;
                    slot.textContent = whatsappStatus.status === 'ready' ? '\u2705' : '\u23F3';
                }
            } catch (e) { /* silent */ }
        }

        async function loadBooks() {
            _showBookSkeletons();
            const result = await _B.loadBooks();
            if (result.success) {
                books = _S.getBooks();
                filteredBooks = _S.getFilteredBooks();
                renderBooks();
                updatePlatformFilter();
                if (isMobile()) renderThumbsZone();
            }
        }

        function createBookListItem(book, selectedFractalId) {
            const searchBox = document.getElementById('searchBox');
            const searchTerm = searchBox ? searchBox.value.trim() : '';
            const hasSearchMatch = searchTerm && (book._matchType === 'message' || book._matchType === 'metadata');
            const isSelected = book.fractal_id === selectedFractalId;
            
            const item = document.createElement('div');
            item.className = `book-list-item ${isSelected ? 'selected' : ''}`;
            item.dataset.fractalId = book.fractal_id;
            item.style.cssText = `display: flex; justify-content: space-between; align-items: center; padding: 0.625rem 0.875rem; cursor: pointer; background: ${isSelected ? 'rgba(88, 101, 242, 0.12)' : 'transparent'}; border-bottom: 1px solid rgba(148, 163, 184, 0.08); transition: background 0.12s ease; user-select: none;`;

            // Drag handle (≡) — left side, touch-safe
            const handle = document.createElement('span');
            handle.className = 'book-drag-handle';
            handle.setAttribute('aria-label', 'Drag to reorder');
            handle.textContent = '⠿';
            item.appendChild(handle);
            
            if (hasSearchMatch) {
                const matchIndicator = document.createElement('div');
                matchIndicator.style.cssText = 'flex-shrink: 0; width: 1.25rem; display: flex; align-items: center; justify-content: center; margin-right: 0.5rem;';
                const checkmark = document.createElement('span');
                checkmark.style.cssText = 'color: #22c55e; font-weight: 700; font-size: 0.875rem;';
                checkmark.textContent = '✓';
                matchIndicator.appendChild(checkmark);
                item.appendChild(matchIndicator);
            }
            
            const contentDiv = document.createElement('div');
            contentDiv.style.cssText = 'flex: 1; min-width: 0;';
            
            const nameDiv = document.createElement('div');
            nameDiv.style.cssText = `color: ${isSelected ? '#e2e8f0' : '#cbd5e1'}; font-weight: ${isSelected ? '600' : '500'}; font-size: 0.8125rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;`;
            nameDiv.textContent = book.name || `${book.input_platform} → Discord`;
            contentDiv.appendChild(nameDiv);
            
            if (book.message_count > 0) {
                const countDiv = document.createElement('div');
                countDiv.style.cssText = 'color: #64748b; font-size: 0.6875rem; margin-top: 0.25rem; line-height: 1;';
                countDiv.textContent = `${book.message_count} messages`;
                contentDiv.appendChild(countDiv);
            }
            
            item.appendChild(contentDiv);
            return item;
        }
        
        function renderBooks(skipDetailRender = false) {
            const sidebar = document.getElementById('bookListContainer');
            const detail = document.getElementById('bookDetail');
            
            if (filteredBooks.length === 0) {
                const sidebarMsg = document.createElement('p');
                sidebarMsg.style.cssText = 'text-align: center; color: #94a3b8; padding: 2rem; font-size: 0.875rem;';
                sidebarMsg.textContent = 'No books found';
                sidebar.replaceChildren(sidebarMsg);
                
                const detailMsg = document.createElement('p');
                detailMsg.style.cssText = 'text-align: center; color: #94a3b8; padding: 2rem;';
                detailMsg.textContent = 'Create your first book to get started!';
                detail.replaceChildren(detailMsg);
                return;
            }
            
            const wasAutoSelected = !selectedBookFractalId || !filteredBooks.find(b => b.fractal_id === selectedBookFractalId);
            if (wasAutoSelected) {
                selectedBookFractalId = filteredBooks[0].fractal_id;
                _persistSelectedBook(selectedBookFractalId, filteredBooks[0].name);
            }
            
            const fragment = document.createDocumentFragment();
            filteredBooks.forEach(book => {
                fragment.appendChild(createBookListItem(book, selectedBookFractalId));
            });
            sidebar.replaceChildren(fragment);

            // Re-init sortable after DOM rebuild
            initBookSortable();
            
            if (!skipDetailRender) {
                // Adam first: on mobile initial auto-select, navigate to messages pane (Eve hidden)
                if (wasAutoSelected && isMobile()) {
                    const _sidebar = document.getElementById('bookSidebar');
                    const _detail  = document.getElementById('bookDetail');
                    if (_sidebar) _sidebar.style.display = 'none';
                    if (_detail)  _detail.style.display  = 'flex';
                }
                renderBookDetail();
                // Reset to fresh state for new book (isLoading:false so loadBookMessages can run)
                messagePageState[selectedBookFractalId] = { isLoading: false, hasOlder: true, seenIds: new Set(), oldestId: null };
                loadBookMessages(selectedBookFractalId, false);
            }
        }

        // ===== BOOK SORT (SortableJS drag-and-drop) =====
        let _bookSortable = null;

        function initBookSortable() {
            const container = document.getElementById('bookListContainer');
            if (!container || typeof Sortable === 'undefined') return;

            // Destroy old instance so renderBooks can re-init cleanly
            if (_bookSortable) { _bookSortable.destroy(); _bookSortable = null; }

            _bookSortable = Sortable.create(container, {
                handle: '.book-drag-handle',
                animation: 150,
                ghostClass: 'sortable-ghost',
                dragClass: 'sortable-drag',
                delay: 120,            // long-press for touch (Apple Stocks feel)
                delayOnTouchOnly: true,
                touchStartThreshold: 5,
                forceFallback: false,
                onEnd(evt) {
                    if (evt.oldIndex === evt.newIndex) return;

                    // SortableJS already moved the DOM; sync the data arrays
                    const allItems = [...container.querySelectorAll('.book-list-item')];
                    const orderedIds = allItems.map(el => el.dataset.fractalId);

                    // Sort books array to match new DOM order
                    books.sort((a, b) => orderedIds.indexOf(a.fractal_id) - orderedIds.indexOf(b.fractal_id));
                    filteredBooks.sort((a, b) => orderedIds.indexOf(a.fractal_id) - orderedIds.indexOf(b.fractal_id));

                    // Build payload and persist
                    const order = orderedIds.map((fractal_id, idx) => ({ fractal_id, sort_order: idx }));
                    const _token = localStorage.getItem('accessToken');
                    fetch('/api/books/reorder', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_token}` },
                        body: JSON.stringify({ order })
                    }).catch(err => console.warn('⚠️ Book reorder save failed:', err));
                }
            });
        }

        async function selectBook(fractalId) {
            selectedBookFractalId = fractalId;
            
            const selectedBook = filteredBooks.find(b => b.fractal_id === fractalId);
            _persistSelectedBook(fractalId, selectedBook?.name);
            if (selectedBook && selectedBook._matchType === 'message' && selectedBook._searchQuery) {
                bookSearchContext = {
                    query: selectedBook._searchQuery,
                    bookId: fractalId
                };
            } else {
                bookSearchContext = { query: '', bookId: null };
            }
            
            const sidebar = document.getElementById('bookListContainer');
            const fragment = document.createDocumentFragment();
            filteredBooks.forEach(book => {
                fragment.appendChild(createBookListItem(book, selectedBookFractalId));
            });
            sidebar.replaceChildren(fragment);
            
            // Messages > sidebar priority: on mobile, switch to messages pane immediately
            if (isMobile()) {
                const bookSidebar = document.getElementById('bookSidebar');
                const bookDetail = document.getElementById('bookDetail');
                if (bookSidebar) bookSidebar.style.display = 'none';
                if (bookDetail) bookDetail.style.display = 'flex';
            }
            
            // Stop polling for previous book before switching
            stopPolling();
            
            // Reset to fresh state with null cursor (isLoading:false so loadBookMessages can run)
            messagePageState[selectedBookFractalId] = { isLoading: false, hasOlder: true, seenIds: new Set(), oldestId: null };
            messageCache[selectedBookFractalId] = null;
            
            await renderBookDetail();
            await loadBookMessages(selectedBookFractalId, false);
            startPolling(fractalId);
        }


        async function renderBookDetail() {
            const book = filteredBooks.find(b => b.fractal_id === selectedBookFractalId);
            if (!book) return;

            _buildDetailShell();
            _bindShellToBook(book.fractal_id, book.name);
            _updateShellVisibility(book);
            _fetchWhatsAppStatus(book);

            const mc = document.getElementById(`discord-messages-${book.fractal_id}`);
            if (mc) mc.innerHTML = '';
        }

        // Helper function to format timestamp with timezone
        function formatTimestampWithTZ(timestamp) {
            const date = new Date(timestamp);
            return date.toLocaleString('en-US', {
                timeZone: 'America/Los_Angeles',
                month: '2-digit',
                day: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZoneName: 'short'
            });
        }

        // Helper function to format phone number with + sign
        function formatPhoneNumber(contact) {
            if (!contact) return 'Unknown';
            // Remove any existing + and whitespace
            const cleaned = contact.replace(/[+\s]/g, '');
            // Add + prefix if it's a number
            return /^\d+$/.test(cleaned) ? `+${cleaned}` : contact;
        }

        // Format timestamp Discord-style (Today at 3:45 PM)
        function formatDiscordTime(timestamp) {
            const date = new Date(timestamp);
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            
            const timeStr = date.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
            
            if (msgDate.getTime() === today.getTime()) {
                return `Today at ${timeStr}`;
            } else if (msgDate.getTime() === today.getTime() - 86400000) {
                return `Yesterday at ${timeStr}`;
            } else {
                return date.toLocaleDateString('en-US', {
                    month: '2-digit',
                    day: '2-digit',
                    year: 'numeric'
                }) + ` at ${timeStr}`;
            }
        }

        // Extract searchable text from embeds
        function extractEmbedSearchText(embeds) {
            if (!embeds || !Array.isArray(embeds)) return '';
            
            return embeds.map(embed => {
                const parts = [];
                if (embed.title) parts.push(embed.title);
                if (embed.description) parts.push(embed.description);
                if (embed.fields && Array.isArray(embed.fields)) {
                    embed.fields.forEach(field => {
                        if (field.name) parts.push(field.name);
                        if (field.value) parts.push(field.value);
                    });
                }
                if (embed.footer) {
                    parts.push(typeof embed.footer === 'string' ? embed.footer : embed.footer.text);
                }
                // Include attachment filename if present
                if (embed.filename) parts.push(embed.filename);
                return parts.join(' ');
            }).join(' ');
        }

        // TIME BUCKET SYSTEM - Personal Cloud OS Timeline Grouping
        function calculateOptimalBucketSize(messageCount, timeSpanDays) {
            if (timeSpanDays === 0) return 24;
            
            const messagesPerDay = messageCount / timeSpanDays;
            
            if (messagesPerDay < 10) {
                return 24;  // Low density: daily buckets
            } else if (messagesPerDay < 30) {
                return 8;   // Medium density: 3 buckets per day
            } else {
                return 6;   // High density: 4 buckets per day
            }
        }

        function getBucketKey(timestamp, bucketHours) {
            const dt = new Date(timestamp);
            const hour = dt.getUTCHours();
            const bucketIndex = Math.floor(hour / bucketHours);
            const bucketStartHour = bucketIndex * bucketHours;
            
            const bucketDate = new Date(dt);
            bucketDate.setUTCHours(bucketStartHour, 0, 0, 0);
            return bucketDate.toISOString();
        }

        function formatBucketLabel(timestamp, bucketHours) {
            const dt = new Date(timestamp);
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const messageDay = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
            
            let dayLabel;
            if (messageDay.getTime() === today.getTime()) {
                dayLabel = 'Today';
            } else if (messageDay.getTime() === yesterday.getTime()) {
                dayLabel = 'Yesterday';
            } else {
                dayLabel = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            }
            
            if (bucketHours === 24) {
                return dayLabel;
            }
            
            const hour = dt.getUTCHours();
            
            if (bucketHours === 8) {
                if (hour === 0) return `${dayLabel} - early daytime (12am-8am)`;
                if (hour === 8) return `${dayLabel} - daytime (8am-4pm)`;
                if (hour === 16) return `${dayLabel} - nighttime (4pm-12am)`;
            } else if (bucketHours === 6) {
                if (hour === 0) return `${dayLabel} - early daytime (12am-6am)`;
                if (hour === 6) return `${dayLabel} - daytime (6am-12pm)`;
                if (hour === 12) return `${dayLabel} - daytime (12pm-6pm)`;
                if (hour === 18) return `${dayLabel} - nighttime (6pm-12am)`;
            }
            
            return dayLabel;
        }

        function analyzeMessageDensity(messages) {
            if (messages.length === 0) {
                return { bucketHours: 24, messageCount: 0, timeSpanDays: 0 };
            }
            
            const timestamps = messages.map(m => new Date(m.timestamp).getTime());
            const oldest = Math.min(...timestamps);
            const newest = Math.max(...timestamps);
            const timeSpanMs = newest - oldest;
            const timeSpanDays = Math.max(1, timeSpanMs / (1000 * 60 * 60 * 24));
            
            const bucketHours = calculateOptimalBucketSize(messages.length, timeSpanDays);
            
            return {
                bucketHours,
                messageCount: messages.length,
                timeSpanDays: Math.ceil(timeSpanDays)
            };
        }

        function groupMessagesByTimeBuckets(messages, bucketHours = 24) {
            const buckets = new Map();
            
            for (const msg of messages) {
                const bucketKey = getBucketKey(msg.timestamp, bucketHours);
                
                if (!buckets.has(bucketKey)) {
                    buckets.set(bucketKey, []);
                }
                buckets.get(bucketKey).push(msg);
            }
            
            const sortedBuckets = Array.from(buckets.entries())
                .sort((a, b) => new Date(b[0]) - new Date(a[0]));
            
            return sortedBuckets.map(([timestamp, messages]) => ({
                timestamp,
                label: formatBucketLabel(timestamp, bucketHours),
                messages
            }));
        }

        // LENS MODE: Filter messages at data level BEFORE rendering
        // Pure function - filters without DOM manipulation
        function applyLensFilter(messages, searchText, statusFilter = 'all') {
            if (!messages || messages.length === 0) return [];
            if (!searchText?.trim() && statusFilter === 'all') return messages;
            
            const searchLower = (searchText || '').toLowerCase().trim();
            
            return messages.filter(msg => {
                // Build searchable text from message data
                const searchableText = [
                    msg.sender_name || '',
                    msg.message_content || '',
                    msg.sender_contact || '',
                    extractEmbedSearchText(msg.embeds),
                    (msg.extracted_tags || []).map(t => '#' + t).join(' ')
                ].join(' ').toLowerCase();
                
                // Match search text
                const matchesSearch = !searchLower || window.searchState?.performSearch(searchLower, searchableText) || searchableText.includes(searchLower);
                
                // Match status filter
                const matchesStatus = statusFilter === 'all' || msg.discord_status === statusFilter;
                
                return matchesSearch && matchesStatus;
            });
        }
        
        // Re-render messages from cache with current lens filter
        async function renderFromCacheWithLens(bookId) {
            const cached = messageCache[bookId];
            if (!cached || cached.length === 0) return;
            
            const filterState = lensFilterState[bookId] || { searchText: '', statusFilter: 'all' };
            const filtered = applyLensFilter(cached, filterState.searchText, filterState.statusFilter);
            
            const container = document.getElementById(`discord-messages-${bookId}`);
            if (!container) return;
            
            // Render filtered messages
            const html = renderDiscordMessages(filtered, bookId);
            container.replaceChildren();
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            while (tempDiv.firstChild) {
                container.appendChild(tempDiv.firstChild);
            }
            
            // Re-initialize supporting features
            restoreCheckboxStates(bookId);
            hydrateDropsForBook(bookId);
            
            setTimeout(() => {
                if (window.initMediaLazyLoading) {
                    window.initMediaLazyLoading();
                }
                normalizeMediaImages(container);
            }, 100);
            
            console.log(`🔍 Lens render: ${filtered.length}/${cached.length} messages (filter: "${filterState.searchText}")`);
        }

        // Render Discord-style messages
        function renderDiscordMessages(data, bookId) {
            const messages = Array.isArray(data) ? data : data?.messages;
            
            console.log('🎨 Rendering messages:', messages?.length, 'messages');
            if (messages && messages.length > 0) {
                console.log('📋 First message embeds:', messages[0].embeds);
                console.log('📝 Message content:', messages[0].message_content);
            }
            
            if (!messages || messages.length === 0) {
                return '<div class="no-messages">No messages yet. Messages will appear here when they arrive.</div>';
            }
            
            // Analyze density and group by time buckets
            const density = analyzeMessageDensity(messages);
            const buckets = groupMessagesByTimeBuckets(messages, density.bucketHours);
            
            console.log(`📊 Timeline: ${buckets.length} buckets (${density.bucketHours}h intervals, ${messages.length} msgs over ${density.timeSpanDays} days)`);
            
            // Render messages grouped by time buckets
            const html = buckets.map(bucket => {
                // Store first message ID for jump-to functionality
                const firstMsgId = bucket.messages[0]?.id || '';
                const bucketHeader = `
                    <div class="time-bucket-header" data-first-msg-id="${firstMsgId}" data-book-id="${bookId}" style="cursor: pointer;">
                        <span class="bucket-label">${bucket.label}</span>
                        <span class="bucket-count">${bucket.messages.length} message${bucket.messages.length !== 1 ? 's' : ''}</span>
                    </div>
                `;
                
                const messagesHtml = bucket.messages.map(msg => {
                // Build comprehensive searchable text including embeds
                const searchableText = [
                    msg.sender_name || '',
                    msg.message_content || '',
                    msg.sender_contact || '',
                    extractEmbedSearchText(msg.embeds),
                    (msg.extracted_tags || []).map(t => '#' + t).join(' ')
                ].join(' ').toLowerCase();
                
                return `
                <div class="discord-message" data-msg-id="${escapeHtml(msg.id)}" data-search-text="${escapeHtml(searchableText)}" data-status="${escapeHtml(msg.discord_status)}" style="position: relative;">
                    <div style="position: absolute; top: 8px; right: 8px; display: flex; align-items: center; gap: 6px; z-index: 10;">
                        ${msg.media_url ? `
                            <a href="${escapeHtml(msg.media_url)}" download title="Download attachment" style="display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: rgba(59, 130, 246, 0.2); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 4px; color: #60a5fa; text-decoration: none; font-size: 0.9rem; transition: all 0.2s; flex-shrink: 0; line-height: 1;">
                                📎
                            </a>
                        ` : ''}
                        <button class="tag-add-btn" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}" title="Add tags" style="display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: rgba(148, 163, 184, 0.2); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 4px; color: #cbd5e1; font-size: 0.9rem; transition: all 0.2s; flex-shrink: 0; cursor: pointer; margin: 0; padding: 0; line-height: 1;">
                            🏷️
                        </button>
                        <label class="custom-checkbox-btn" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}" title="Select for export" style="position: relative; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: rgba(148, 163, 184, 0.2); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 4px; color: #cbd5e1; font-size: 0.9rem; cursor: pointer; margin: 0; padding: 0; flex-shrink: 0; transition: all 0.2s; line-height: 1;">
                            <input type="checkbox" class="message-export-checkbox message-checkbox" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}" style="display: none;">
                            <span class="checkbox-icon" style="font-size: 0.9rem; line-height: 1; pointer-events: none;">☐</span>
                        </label>
                    </div>
                    <div class="discord-avatar">
                        ${msg.sender_photo_url ? 
                            `<img src="${escapeHtml(msg.sender_photo_url)}" alt="${escapeHtml(msg.sender_name || 'User')}" class="avatar-photo" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">
                             <div class="avatar-fallback" style="display: none; width: 100%; height: 100%; align-items: center; justify-content: center;">${escapeHtml(msg.sender_name ? msg.sender_name.charAt(0).toUpperCase() : '?')}</div>` :
                            `${escapeHtml(msg.sender_name ? msg.sender_name.charAt(0).toUpperCase() : '?')}`
                        }
                    </div>
                    <div class="discord-content">
                        <div class="discord-header-row">
                            <span class="discord-username" style="color: ${msg.sender_contact ? (msg.is_creator ? '#22c55e' : '#60a5fa') : '#ffffff'};">${msg.sender_contact ? formatPhoneNumber(msg.sender_contact) : escapeHtml(msg.sender_name || 'Unknown')}</span>
                            <span class="discord-timestamp discord-timestamp-desktop">${formatDiscordTime(msg.timestamp)}</span>
                            <span class="discord-status-badge status-${escapeHtml(msg.discord_status)}">${msg.discord_status === 'success' ? '✓' : msg.discord_status === 'failed' ? '✗' : '⏳'}</span>
                            <button class="jump-to-msg-btn" data-msg-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}">Jump</button>
                        </div>
                        <div class="discord-timestamp discord-timestamp-mobile">${formatDiscordTime(msg.timestamp)}</div>
                        <div class="message-drop-section" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}">
                            <div class="drop-display hidden"></div>
                        </div>
                        ${msg.message_content ? `<div class="discord-text">${escapeHtml(msg.message_content)}</div>` : ''}
                        ${msg.embeds && msg.embeds.length > 0 ? msg.embeds.map(embed => {
                            const phoneField = (embed.fields || []).find(f => 
                                (f.name || '').toLowerCase().includes('phone') || f.name.includes('📞') || f.name.includes('📱')
                            );
                            const isWhatsAppMirror = !!phoneField;
                            
                            if (isWhatsAppMirror) {
                                return '';
                            }
                            
                            return `
                            <div class="discord-embed" style="background: rgba(47, 49, 54, 0.6); border-radius: 4px; padding: 0.75rem; margin-top: 0.5rem; max-width: 520px;">
                                ${embed.title ? `<div class="embed-title" style="font-weight: 600; color: #00AFF4; margin-bottom: 0.5rem;">${escapeHtml(embed.title)}</div>` : ''}
                                ${embed.description && !embed.description.includes('No text content') ? `<div class="embed-description" style="color: #DCDDDE; margin-bottom: 0.5rem; white-space: pre-wrap;">${escapeHtml(embed.description)}</div>` : ''}
                                ${embed.fields && embed.fields.length > 0 ? `
                                    <div class="embed-fields" style="display: grid; grid-template-columns: repeat(${embed.fields.some(f => !f.inline) ? '1' : '2'}, 1fr); gap: 0.5rem;">
                                        ${embed.fields.filter(field => !field.name.includes('📝 Attachment')).map(field => `
                                            <div class="embed-field" style="${field.inline ? 'display: inline-block;' : ''}">
                                                <div class="embed-field-name" style="font-weight: 600; color: #B9BBBE; font-size: 0.875rem; margin-bottom: 0.25rem;">${escapeHtml(field.name)}</div>
                                                <div class="embed-field-value" style="color: #DCDDDE; font-size: 0.875rem;">${escapeHtml(field.value)}</div>
                                            </div>
                                        `).join('')}
                                    </div>
                                ` : ''}
                                ${embed.footer ? `<div class="embed-footer" style="color: #72767D; font-size: 0.75rem; margin-top: 0.5rem;">${escapeHtml(embed.footer.text || embed.footer)}</div>` : ''}
                                ${embed.image ? `<img src="${escapeHtml(embed.image.url || embed.image)}" class="discord-media-image" style="margin-top: 0.5rem;" alt="Embed image">` : ''}
                            </div>`;
                        }).join('') : ''}
                        ${msg.has_media ? `
                            <div class="discord-media-preview" id="media-preview-${escapeHtml(msg.id)}" data-message-id="${escapeHtml(msg.id)}" data-media-url="${escapeHtml(msg.media_url || '')}" data-media-type="${escapeHtml(msg.media_type || '')}">
                                <div class="media-loading">Loading media...</div>
                            </div>
                        ` : ''}
                        ${msg.media_url && !msg.has_media ? `
                            <div class="discord-attachment" style="margin-top: 0.5rem;">
                                <img src="${escapeHtml(msg.media_url)}" class="discord-media-image" alt="Discord attachment" loading="lazy" onerror="this.style.display='none'">
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
                }).join('');
                
                return bucketHeader + messagesHtml;
            }).join('');
            
            return html;
        }

        // Highlight search terms in text
        function highlightText(text, query) {
            if (!query || !text) return escapeHtml(text);
            const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(${escapedQuery})`, 'gi');
            return escapeHtml(text).replace(regex, '<mark>$1</mark>');
        }

        // Helper: Parse date and jump to first message from that date
        async function jumpToMessageDate(bookId, dateRange) {
            const messagesContainer = document.getElementById(`discord-messages-${bookId}`);
            if (!messagesContainer) return;
            
            const bucketHeaders = messagesContainer.querySelectorAll('.time-bucket-header');
            const targetDate = dateRange.dateFrom; // ISO format YYYY-MM-DD
            
            // Find bucket header matching the target date
            let targetBucket = null;
            for (const header of bucketHeaders) {
                const headerText = header.textContent || '';
                // Match date in various formats that might appear in header
                if (headerText.includes(targetDate.split('-')[0]) || 
                    headerText.toLowerCase().includes(dateRange.context.toLowerCase())) {
                    targetBucket = header;
                    break;
                }
            }
            
            // If no exact match, find closest date
            if (!targetBucket) {
                const targetTime = new Date(targetDate).getTime();
                let closestBucket = null;
                let closestDiff = Infinity;
                
                bucketHeaders.forEach(header => {
                    const headerText = header.textContent || '';
                    // Extract date from common formats like "Today", "Yesterday", or "Dec 05, 2025"
                    const dateMatch = headerText.match(/([A-Z][a-z]+\s+\d{2},?\s+\d{4}|Today|Yesterday)/);
                    if (dateMatch) {
                        try {
                            const headerDate = new Date(dateMatch[0]);
                            if (!isNaN(headerDate)) {
                                const diff = Math.abs(headerDate.getTime() - targetTime);
                                if (diff < closestDiff) {
                                    closestDiff = diff;
                                    closestBucket = header;
                                }
                            }
                        } catch (e) {
                            // Skip invalid dates
                        }
                    }
                });
                targetBucket = closestBucket;
            }
            
            // Scroll to and highlight the target bucket
            if (targetBucket) {
                targetBucket.scrollIntoView({ behavior: 'smooth', block: 'start' });
                
                // Flash highlight effect
                const originalBg = targetBucket.style.background;
                targetBucket.style.background = 'rgba(59, 130, 246, 0.2)';
                targetBucket.style.transition = 'background 0.3s ease';
                
                setTimeout(() => {
                    targetBucket.style.background = originalBg || '';
                }, 1500);
                
                console.log(`📅 Jumped to ${dateRange.context}`);
            }
        }

        // Universal Search - LENS MODE: filter-then-render architecture
        // Filters messages at data level and re-renders from cache
        async function filterDiscordMessages(bookId) {
            const searchText = document.getElementById(`msg-search-${bookId}`)?.value || '';
            const statusFilter = document.getElementById(`status-filter-${bookId}`)?.value || 'all';
            
            // Update lens filter state
            lensFilterState[bookId] = { searchText, statusFilter };
            
            // Check if search text is a date format
            const dateRange = parseNaturalLanguageDate(searchText);
            if (dateRange) {
                console.log(`📅 Date detected: ${dateRange.context} (${dateRange.dateFrom} to ${dateRange.dateTo})`);
                // Clear filter and jump to date
                lensFilterState[bookId] = { searchText: '', statusFilter: 'all' };
                await renderFromCacheWithLens(bookId);
                await jumpToMessageDate(bookId, dateRange);
                
                // Show date context indicator
                const contextEl = document.createElement('div');
                contextEl.style.cssText = `
                    position: fixed;
                    top: 80px;
                    right: 20px;
                    background: rgba(59, 130, 246, 0.9);
                    color: white;
                    padding: 8px 16px;
                    border-radius: 6px;
                    font-size: 12px;
                    z-index: 9999;
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(59, 130, 246, 0.3);
                `;
                contextEl.textContent = `📅 Showing: ${dateRange.context}`;
                
                document.querySelectorAll('[data-date-context]').forEach(el => el.remove());
                contextEl.setAttribute('data-date-context', 'true');
                document.body.appendChild(contextEl);
                
                setTimeout(() => {
                    contextEl.style.opacity = '0';
                    contextEl.style.transition = 'opacity 0.3s ease';
                    setTimeout(() => contextEl.remove(), 300);
                }, 3000);
                
                return;
            }
            
            // LENS MODE: Re-render from cache with filter applied
            await renderFromCacheWithLens(bookId);
            
            // Post-render: Search drops metadata and highlight matches
            let dropsMatches = new Set();
            if (searchText.trim()) {
                try {
                    const response = await window.authFetch(`/api/drops/search/${bookId}?q=${encodeURIComponent(searchText)}`);
                    if (response.ok) {
                        const drops = await response.json();
                        drops.forEach(drop => dropsMatches.add(drop.discord_message_id));
                        console.log(`🔍 Found ${drops.length} drops matching "${searchText}"`);
                        
                        // Highlight drop matches in rendered DOM
                        dropsMatches.forEach(msgId => {
                            const msgEl = document.querySelector(`.discord-message[data-msg-id="${msgId}"]`);
                            if (msgEl) {
                                msgEl.style.borderLeft = '3px solid rgba(167, 139, 250, 0.6)';
                            }
                        });
                    }
                } catch (err) {
                    console.log('Drop search skipped:', err.message);
                }
            }
            
            // Get rendered messages and bucket headers for UI updates
            const messages = document.querySelectorAll(`#discord-messages-${bookId} .discord-message`);
            const bucketHeaders = document.querySelectorAll(`#discord-messages-${bookId} .time-bucket-header`);
            const totalMatches = messages.length;
            
            // Update bucket headers with match counts and preview bubbles when searching
            if (searchText.trim() || statusFilter !== 'all') {
                bucketHeaders.forEach(header => {
                    // Find all messages in this bucket
                    let currentEl = header.nextElementSibling;
                    let matchCount = 0;
                    const matchingMessages = [];
                    
                    // Skip existing preview container
                    if (currentEl && currentEl.classList.contains('search-preview-container')) {
                        currentEl = currentEl.nextElementSibling;
                    }
                    
                    while (currentEl && !currentEl.classList.contains('time-bucket-header')) {
                        if (currentEl.classList.contains('discord-message') && currentEl.style.display !== 'none') {
                            matchCount++;
                            matchingMessages.push(currentEl);
                            currentEl.classList.add('search-match');
                        } else if (currentEl.classList.contains('discord-message')) {
                            currentEl.classList.remove('search-match');
                        }
                        currentEl = currentEl.nextElementSibling;
                    }
                    
                    // Update bucket count display
                    const countEl = header.querySelector('.bucket-count');
                    if (countEl && matchCount > 0) {
                        countEl.textContent = `${matchCount} match${matchCount !== 1 ? 'es' : ''}`;
                        countEl.style.background = 'rgba(59, 130, 246, 0.2)';
                        countEl.style.color = '#60a5fa';
                        header.style.display = 'flex';
                    } else if (countEl) {
                        header.style.display = matchCount > 0 ? 'flex' : 'none';
                    }
                    
                    if (searchText.trim() && matchCount > 0) {
                        const buildPreviewElements = () => {
                            const fragment = document.createDocumentFragment();
                            const previewLimit = 3;
                            
                            for (let i = 0; i < Math.min(previewLimit, matchingMessages.length); i++) {
                                const msg = matchingMessages[i];
                                const username = msg.querySelector('.discord-username')?.textContent || 'Unknown';
                                const textEl = msg.querySelector('.discord-text');
                                const content = textEl?.textContent || '';
                                const msgId = msg.getAttribute('data-msg-id');
                                
                                const bubble = document.createElement('div');
                                bubble.className = 'search-preview-bubble';
                                bubble.dataset.targetId = msgId;
                                
                                const strong = document.createElement('strong');
                                strong.textContent = `${username}: `;
                                bubble.appendChild(strong);
                                
                                const previewText = document.createElement('span');
                                previewText.className = 'preview-text';
                                previewText.textContent = content;
                                bubble.appendChild(previewText);
                                
                                const jumpSpan = document.createElement('span');
                                jumpSpan.className = 'preview-jump';
                                jumpSpan.textContent = 'Jump';
                                bubble.appendChild(jumpSpan);
                                
                                fragment.appendChild(bubble);
                            }
                            
                            if (matchCount > previewLimit) {
                                const moreDiv = document.createElement('div');
                                moreDiv.className = 'more-matches';
                                moreDiv.textContent = `...and ${matchCount - previewLimit} more`;
                                fragment.appendChild(moreDiv);
                            }
                            return fragment;
                        };
                        
                        let existingPreview = header.nextElementSibling;
                        if (existingPreview && existingPreview.classList.contains('search-preview-container')) {
                            existingPreview.replaceChildren(buildPreviewElements());
                        } else {
                            const previewContainer = document.createElement('div');
                            previewContainer.className = 'search-preview-container';
                            previewContainer.appendChild(buildPreviewElements());
                            header.after(previewContainer);
                        }
                    } else {
                        // Remove preview container if exists
                        const existingPreview = header.nextElementSibling;
                        if (existingPreview && existingPreview.classList.contains('search-preview-container')) {
                            existingPreview.remove();
                        }
                    }
                });
            } else {
                // Reset bucket headers and remove previews when not searching
                bucketHeaders.forEach(header => {
                    header.style.display = 'flex';
                    
                    // Remove preview container FIRST (before iterating)
                    const existingPreview = header.nextElementSibling;
                    if (existingPreview && existingPreview.classList.contains('search-preview-container')) {
                        existingPreview.remove();
                    }
                    
                    // Remove search-match class from all messages
                    let currentEl = header.nextElementSibling;
                    while (currentEl && !currentEl.classList.contains('time-bucket-header')) {
                        if (currentEl.classList.contains('discord-message')) {
                            currentEl.classList.remove('search-match');
                        }
                        currentEl = currentEl.nextElementSibling;
                    }
                    
                    const countEl = header.querySelector('.bucket-count');
                    if (countEl) {
                        // Restore original count (count all messages in bucket)
                        let totalCount = 0;
                        currentEl = header.nextElementSibling;
                        while (currentEl && !currentEl.classList.contains('time-bucket-header')) {
                            if (currentEl.classList.contains('discord-message')) {
                                totalCount++;
                            }
                            currentEl = currentEl.nextElementSibling;
                        }
                        countEl.textContent = `${totalCount} message${totalCount !== 1 ? 's' : ''}`;
                        countEl.style.background = 'rgba(15, 23, 42, 0.3)';
                        countEl.style.color = '#94a3b8';
                    }
                });
            }
        }

        // SEAMLESS SEARCH: Clear book search filter and hide indicator
        function clearBookSearchFilter(bookId) {
            // Clear the search box
            const searchBox = document.getElementById(`msg-search-${bookId}`);
            if (searchBox) {
                searchBox.value = '';
            }
            
            // Hide the indicator
            const indicator = document.getElementById(`search-indicator-${bookId}`);
            if (indicator) {
                indicator.style.display = 'none';
            }
            
            // Clear the search context
            bookSearchContext = { query: '', bookId: null };
            
            // Re-filter to show all messages
            filterDiscordMessages(bookId);
        }

        function renderMessages(data, bookId) {
            // Handle both array format and object format
            const messages = Array.isArray(data) ? data : data?.messages;
            const page = data?.page || 1;
            const totalPages = data?.totalPages || 1;
            const total = data?.total || (messages ? messages.length : 0);
            
            if (!messages || messages.length === 0) {
                return '<div style="text-align: center; padding: 1rem; color: #94a3b8;">No messages yet</div>';
            }
            
            return `
                <div class="message-table-container">
                    <div style="margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
                        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                            <input type="text" id="msg-filter-${bookId}" placeholder="🔍 Filter messages..." style="padding: 0.5rem; background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0;" data-filter-table="${bookId}">
                            <select id="status-filter-${bookId}" data-status-filter="${bookId}" style="padding: 0.5rem; background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0;">
                                <option value="all">All Status</option>
                                <option value="success">Success</option>
                                <option value="failed">Failed</option>
                                <option value="pending">Pending</option>
                            </select>
                        </div>
                        <span style="color: #94a3b8; font-size: 0.875rem;">Total: ${total} messages</span>
                    </div>

                    <table class="message-table" id="msg-table-${bookId}">
                        <thead>
                            <tr>
                                <th style="text-align: center; width: 50px;">
                                    <input type="checkbox" id="select-all-${bookId}" title="Select all messages">
                                </th>
                                <th data-book-id="${bookId}" data-sort-column="timestamp" style="min-width: 200px;">
                                    Timestamp<span class="sort-icon">↕</span>
                                </th>
                                <th data-book-id="${bookId}" data-sort-column="contact" style="min-width: 180px;">
                                    Contact / Phone<span class="sort-icon">↕</span>
                                </th>
                                <th data-book-id="${bookId}" data-sort-column="message">
                                    Message<span class="sort-icon">↕</span>
                                </th>
                                <th style="text-align: center; width: 100px;">Status</th>
                                <th style="text-align: center; width: 100px;">Attachments</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${messages.map((msg, index) => `
                                <tr data-timestamp="${escapeHtml(msg.timestamp)}" data-contact="${escapeHtml(msg.sender_contact || '')}" data-message="${escapeHtml(msg.message_content)}" data-status="${escapeHtml(msg.discord_status)}" data-msg-id="${escapeHtml(msg.id)}">
                                    <td style="text-align: center;">
                                        <input type="checkbox" class="message-checkbox" data-msg-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}">
                                    </td>
                                    <td class="timestamp-col">${formatTimestampWithTZ(msg.timestamp)}</td>
                                    <td class="contact-col">
                                        <div style="font-weight: 600;">${escapeHtml(msg.sender_name || 'Unknown')}</div>
                                        <div style="color: #94a3b8; font-size: 0.75rem;">${formatPhoneNumber(msg.sender_contact)}</div>
                                    </td>
                                    <td class="message-col">${escapeHtml(msg.message_content)}</td>
                                    <td style="text-align: center;">
                                        <span class="status-badge status-${escapeHtml(msg.discord_status)}">
                                            ${escapeHtml(msg.discord_status ? msg.discord_status.toUpperCase() : '')}
                                        </span>
                                    </td>
                                    <td class="attachment-col">
                                        ${msg.has_media ? `
                                            <span class="attachment-icon" data-message-id="${escapeHtml(msg.id)}" title="${escapeHtml(msg.media_type || 'Media')}">
                                                📎
                                            </span>
                                        ` : '-'}
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>

                    ${totalPages > 1 ? `
                        <div style="margin-top: 1rem; display: flex; justify-content: center; gap: 0.5rem; align-items: center;">
                            <button class="btn" ${page <= 1 ? 'disabled' : ''} data-book-id="${bookId}" data-load-page="${page - 1}" style="padding: 0.375rem 0.75rem;">← Prev</button>
                            <span style="color: #94a3b8; font-size: 0.875rem;">Page ${page} / ${totalPages}</span>
                            <button class="btn" ${page >= totalPages ? 'disabled' : ''} data-book-id="${bookId}" data-load-page="${page + 1}" style="padding: 0.375rem 0.75rem;">Next →</button>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        // Sort messages table by column
        let messageSortState = {};
        function sortMessagesTable(bookId, column) {
            if (!messageSortState[bookId]) messageSortState[bookId] = {};
            const table = document.getElementById(`msg-table-${bookId}`);
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            
            // Toggle sort direction
            const currentDir = messageSortState[bookId][column] || 'asc';
            const newDir = currentDir === 'asc' ? 'desc' : 'asc';
            messageSortState[bookId] = { [column]: newDir };
            
            rows.sort((a, b) => {
                let aVal, bVal;
                if (column === 'timestamp') {
                    aVal = new Date(a.dataset.timestamp);
                    bVal = new Date(b.dataset.timestamp);
                } else if (column === 'contact') {
                    aVal = a.dataset.contact.toLowerCase();
                    bVal = b.dataset.contact.toLowerCase();
                } else if (column === 'message') {
                    aVal = a.dataset.message.toLowerCase();
                    bVal = b.dataset.message.toLowerCase();
                }
                
                if (newDir === 'asc') {
                    return aVal > bVal ? 1 : -1;
                } else {
                    return aVal < bVal ? 1 : -1;
                }
            });
            
            // Update table
            rows.forEach(row => tbody.appendChild(row));
            
            // Update sort icons
            table.querySelectorAll('th').forEach(th => th.classList.remove('sorted'));
            table.querySelector(`th[onclick*="${column}"]`).classList.add('sorted');
        }

        // Filter messages table using universal search
        function filterMessagesTable(bookId) {
            const textFilter = document.getElementById(`msg-filter-${bookId}`).value;
            const statusFilter = document.getElementById(`status-filter-${bookId}`).value;
            const table = document.getElementById(`msg-table-${bookId}`);
            const rows = table.querySelectorAll('tbody tr');
            
            rows.forEach(row => {
                const searchableText = row.dataset.message + ' ' + row.dataset.contact;
                const status = row.dataset.status;
                
                const matchesText = window.searchState.performSearch(textFilter, searchableText);
                const matchesStatus = statusFilter === 'all' || status === statusFilter;
                
                row.style.display = (matchesText && matchesStatus) ? '' : 'none';
            });
        }

        // Show media preview with actual image/video
        async function showMediaPreview(messageId) {
            try {
                const response = await window.authFetch(`/api/messages/${messageId}/media`);
                if (!response.ok) {
                    alert('Media not available');
                    return;
                }
                
                const data = await response.json();
                const modal = document.getElementById('mediaModal');
                const modalContent = document.getElementById('mediaModalContent');
                const modalCaption = document.getElementById('mediaModalCaption');
                
                modalCaption.textContent = `${data.sender_name || 'Unknown'} - ${data.media_type || 'Media'}`;
                
                const mediaType = (data.media_type || '').toLowerCase();
                modalContent.replaceChildren();
                
                if (mediaType.includes('image')) {
                    const img = document.createElement('img');
                    img.src = data.media_data;
                    img.alt = 'Media Preview';
                    modalContent.appendChild(img);
                } else if (mediaType.includes('video')) {
                    const video = document.createElement('video');
                    video.controls = true;
                    video.autoplay = true;
                    const source = document.createElement('source');
                    source.src = data.media_data;
                    source.type = data.media_type;
                    video.appendChild(source);
                    modalContent.appendChild(video);
                } else if (mediaType.includes('audio')) {
                    const audio = document.createElement('audio');
                    audio.controls = true;
                    audio.autoplay = true;
                    const source = document.createElement('source');
                    source.src = data.media_data;
                    source.type = data.media_type;
                    audio.appendChild(source);
                    modalContent.appendChild(audio);
                } else {
                    const fallback = document.createElement('div');
                    fallback.style.cssText = 'color: white; padding: 2rem;';
                    fallback.textContent = `Preview not available for ${data.media_type}`;
                    modalContent.appendChild(fallback);
                }
                
                modal.classList.add('active');
            } catch (error) {
                console.error('Error loading media:', error);
                alert('Error loading media preview');
            }
        }
        
        function closeMediaModal() {
            const modal = document.getElementById('mediaModal');
            modal.classList.remove('active');
            document.getElementById('mediaModalContent').replaceChildren();
        }

        // Book Actions Menu - Stacked options for button 4
        function showBookActionsMenu() {
            // Get current book
            const currentBookId = document.querySelector('.discord-messages-container')?.id?.replace('discord-messages-', '');
            if (!currentBookId) {
                showToast('⚠️ No book selected', 'error');
                return;
            }
            
            const activeBooks = filteredBooks.length > 0 ? filteredBooks : books;
            const currentBook = activeBooks.find(b => b.fractal_id === currentBookId);
            
            if (!currentBook) {
                showToast('⚠️ Book not found', 'error');
                return;
            }
            
            // Create stacked action menu
            let actionsMenu = document.getElementById('bookActionsMenu');
            if (!actionsMenu) {
                const menuHtml = `
                    <div id="bookActionsMenu" class="book-fan-modal" style="z-index: 10000;">
                        <div class="book-fan-content" style="max-width: 350px; padding: 1.5rem;">
                            <button class="book-fan-close" id="actionsMenuClose">×</button>
                            <h3 style="margin-bottom: 1rem; font-size: 1.25rem; background: linear-gradient(135deg, #a855f7, #ec4899, #f59e0b, #10b981, #3b82f6, #6366f1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">Book Actions</h3>
                            <div id="bookActionsContent"></div>
                        </div>
                    </div>
                `;
                document.body.insertAdjacentHTML('beforeend', menuHtml);
                actionsMenu = document.getElementById('bookActionsMenu');
                
                // Add event listeners
                actionsMenu.addEventListener('click', function(e) {
                    if (e.target === this) closeBookActionsMenu();
                });
                document.getElementById('actionsMenuClose').addEventListener('click', closeBookActionsMenu);
            }
            
            const actions = [
                { icon: 'ℹ️', label: 'Book Info', action: 'info', color: '#3b82f6' },
                { icon: '📚', label: 'View All Books', action: 'fan', color: '#10b981' },
                { icon: '📱', label: 'Display Code', action: 'regenerate-qr', color: '#a855f7' },
                { icon: '✏️', label: 'Edit Book', action: 'edit', color: '#f59e0b' },
                { icon: '🗑️', label: 'Delete Book', action: 'delete', color: '#ef4444' }
            ];
            
            const actionsContainer = document.createElement('div');
            actionsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 0.75rem;';
            
            actions.forEach(action => {
                const btn = document.createElement('button');
                btn.className = 'book-action-btn';
                btn.dataset.action = action.action;
                btn.style.cssText = 'width: 100%; padding: 1rem; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 12px; color: #e2e8f0; font-size: 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.75rem; transition: all 0.2s ease;';
                
                const iconSpan = document.createElement('span');
                iconSpan.style.cssText = 'font-size: 1.5rem;';
                iconSpan.textContent = action.icon;
                btn.appendChild(iconSpan);
                
                const labelSpan = document.createElement('span');
                labelSpan.style.cssText = 'flex: 1; text-align: left;';
                labelSpan.textContent = action.label;
                btn.appendChild(labelSpan);
                
                const arrowSpan = document.createElement('span');
                arrowSpan.style.cssText = 'opacity: 0.5;';
                arrowSpan.textContent = '→';
                btn.appendChild(arrowSpan);
                
                actionsContainer.appendChild(btn);
            });
            
            document.getElementById('bookActionsContent').replaceChildren(actionsContainer);
            
            // Add click handlers to action buttons
            actionsMenu.querySelectorAll('.book-action-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const action = this.dataset.action;
                    closeBookActionsMenu();
                    
                    switch(action) {
                        case 'info':
                            showBookInfoModal();
                            break;
                        case 'fan':
                            showBookFanModal();
                            break;
                        case 'regenerate-qr':
                            showWhatsAppActivationModal(currentBook.fractal_id);
                            break;
                        case 'edit':
                            showEditBookModal(currentBook);
                            break;
                        case 'delete':
                            showDeleteBookConfirmation(currentBook);
                            break;
                    }
                });
            });
            
            actionsMenu.style.display = 'flex';
        }
        
        function closeBookActionsMenu() {
            const menu = document.getElementById('bookActionsMenu');
            if (menu) menu.style.display = 'none';
        }
        
        // AI Audit Modal - AI-powered message checking (Two-pane layout)
        function showNyanAuditModal() {
            let auditModal = document.getElementById('nyanAuditModal');
            if (!auditModal) {
                const modalHtml = `
                    <div id="nyanAuditModal" class="book-fan-modal" style="z-index: 10000;">
                        <div class="book-fan-content" style="max-width: 960px; width: 95vw; padding: 1.5rem; max-height: 90vh; display: flex; flex-direction: column;">
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; flex-shrink: 0;">
                                <h3 style="margin: 0; font-size: 1.25rem; background: linear-gradient(135deg, #a855f7, #ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">🧿 AI Audit</h3>
                                <button class="book-fan-close" id="nyanAuditClose" style="position: static; margin: 0;">×</button>
                            </div>
                            
                            <!-- Book Selection Controls -->
                            <div style="display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; align-items: flex-start;">
                                <!-- Book Selector -->
                                <div style="flex: 2; min-width: 280px;">
                                    <div style="font-size: 0.7rem; color: #94a3b8; margin-bottom: 0.35rem; font-weight: 600; display: flex; justify-content: space-between; align-items: center;">
                                        <span>📚 Books</span>
                                        <div style="font-size: 0.65rem; gap: 0.25rem; display: flex;">
                                            <button id="bookSelectAll" style="padding: 0.15rem 0.5rem; background: rgba(34, 211, 238, 0.2); border: 1px solid rgba(34, 211, 238, 0.3); border-radius: 3px; color: #22d3ee; cursor: pointer; font-size: 0.65rem;">All</button>
                                            <button id="bookSelectNone" style="padding: 0.15rem 0.5rem; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 3px; color: #ef4444; cursor: pointer; font-size: 0.65rem;">None</button>
                                        </div>
                                    </div>
                                    
                                    <!-- Selected Books (Bubbles) -->
                                    <div id="auditSelectedBubbles" style="display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 0.375rem 0; margin-bottom: 0.5rem; min-height: 20px;">
                                        <span style="color: #64748b; font-size: 0.7rem;">Loading...</span>
                                    </div>
                                    
                                    <!-- Dropdown Toggle & Search -->
                                    <div style="position: relative;">
                                        <div style="display: flex; gap: 0.5rem;">
                                            <input id="bookSearchInput" type="text" placeholder="🔍 Search books..." style="flex: 1; padding: 0.5rem 0.75rem; background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 6px; color: #e2e8f0; font-size: 0.8rem;" />
                                            <button id="bookDropdownToggle" style="padding: 0.5rem 0.75rem; background: rgba(148, 163, 184, 0.15); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 6px; color: #94a3b8; cursor: pointer; font-size: 0.8rem; min-width: 40px;">▼</button>
                                        </div>
                                        
                                        <!-- Dropdown List -->
                                        <div id="auditBookDropdown" style="position: absolute; top: 100%; left: 0; right: 0; margin-top: 0.25rem; background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 6px; max-height: 200px; overflow-y: auto; z-index: 1001; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
                                            <div style="padding: 0.5rem; color: #64748b; font-size: 0.75rem;">Loading books...</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            
                            <div id="nyanAuditGrid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; flex: 1; min-height: 0; overflow: visible;">
                                <!-- Left Pane: Input -->
                                <div style="display: flex; flex-direction: column; min-height: 0;">
                                    <div style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.5rem; font-weight: 600;">📝 Your Query</div>
                                    <textarea id="nyanAuditMessage" class="form-input" placeholder="Ask anything about your data..." style="padding: 0.75rem; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; color: #e2e8f0; width: 100%; flex: 1; min-height: 150px; resize: none; font-family: inherit; box-sizing: border-box;"></textarea>
                                    
                                    <div id="nyanAuditBookContext" style="margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: rgba(34, 211, 238, 0.1); border: 1px solid rgba(34, 211, 238, 0.3); border-radius: 6px; color: #22d3ee; font-size: 0.75rem; flex-shrink: 0;">
                                        📚 Searching all authorized books
                                    </div>
                                    
                                    
                                    <button id="nyanAuditCheckBtn" class="form-button" style="width: 100%; margin-top: 0.75rem; padding: 0.75rem; background: linear-gradient(135deg, #a855f7, #ec4899); border: none; border-radius: 8px; color: white; font-weight: 600; cursor: pointer; transition: opacity 0.2s; flex-shrink: 0;">
                                        🔮 Run AI Check
                                    </button>
                                </div>
                                
                                <!-- Right Pane: Result -->
                                <div style="display: flex; flex-direction: column; min-height: 0;">
                                    <div style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.5rem; font-weight: 600;">💬 AI Response</div>
                                    <div id="nyanAuditResult" style="flex: 1; overflow-y: auto; padding: 1rem; background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; min-height: 150px;">
                                        <div id="nyanAuditResultContent" style="color: #64748b; font-size: 0.875rem;">
                                            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 2rem 1rem;">
                                                <div style="font-size: 2.5rem; margin-bottom: 0.75rem; opacity: 0.6;">🔮</div>
                                                <p style="margin: 0; color: #64748b;">Enter your query and click "Run AI Check" to get an answer</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            
                            <style>
                                @media (max-width: 768px) {
                                    #nyanAuditGrid {
                                        grid-template-columns: 1fr !important;
                                        gap: 1rem !important;
                                        overflow: visible !important;
                                    }
                                    #nyanAuditModal .book-fan-content {
                                        max-width: 100% !important;
                                        width: 100% !important;
                                        height: 100vh !important;
                                        max-height: 100vh !important;
                                        border-radius: 0 !important;
                                        overflow-y: auto !important;
                                    }
                                }
                            </style>
                        </div>
                    </div>
                `;
                document.body.insertAdjacentHTML('beforeend', modalHtml);
                auditModal = document.getElementById('nyanAuditModal');
                
                // Event listeners
                auditModal.addEventListener('click', function(e) {
                    if (e.target === this) closeNyanAuditModal();
                });
                document.getElementById('nyanAuditClose').addEventListener('click', closeNyanAuditModal);
                document.getElementById('nyanAuditCheckBtn').addEventListener('click', runNyanAuditCheck);
                
            }
            
            document.getElementById('nyanAuditMessage').value = '';
            
            const resultContent = document.getElementById('nyanAuditResultContent');
            const emptyState = document.createElement('div');
            emptyState.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 2rem 1rem;';
            const emptyIcon = document.createElement('div');
            emptyIcon.style.cssText = 'font-size: 2.5rem; margin-bottom: 0.75rem; opacity: 0.6;';
            emptyIcon.textContent = '🔮';
            emptyState.appendChild(emptyIcon);
            const emptyText = document.createElement('p');
            emptyText.style.cssText = 'margin: 0; color: #64748b;';
            emptyText.textContent = 'Enter your query and click "Run AI Check" to get an answer';
            emptyState.appendChild(emptyText);
            resultContent.replaceChildren(emptyState);
            
            document.getElementById('nyanAuditCheckBtn').disabled = false;
            document.getElementById('nyanAuditCheckBtn').textContent = '🔮 Run AI Check';
            
            // Initialize book selector with dropdown + search + bubbles
            // Auto-select only the currently viewed book for better UX
            const _currentBookId = selectedBookFractalId || (books && books.length > 0 ? books[0].fractal_id : null);
            window.auditSelectedBooks = new Set(_currentBookId ? [_currentBookId] : []);
            window.auditAllBooks = books || [];
            
            const renderSelectedBubbles = () => {
                const bubblesDiv = document.getElementById('auditSelectedBubbles');
                if (!bubblesDiv) return;
                
                if (window.auditSelectedBooks.size === 0) {
                    const noBooks = document.createElement('span');
                    noBooks.style.cssText = 'color: #64748b; font-size: 0.7rem;';
                    noBooks.textContent = 'No books selected';
                    bubblesDiv.replaceChildren(noBooks);
                } else {
                    const fragment = document.createDocumentFragment();
                    Array.from(window.auditSelectedBooks).forEach(fractalId => {
                        const book = window.auditAllBooks.find(b => b.fractal_id === fractalId);
                        const name = book ? book.name : fractalId;
                        const displayName = name.length > 12 ? name.substring(0, 12) + '...' : name;
                        
                        const bubble = document.createElement('span');
                        bubble.className = 'audit-selected-bubble';
                        bubble.dataset.fractalId = fractalId;
                        bubble.style.cssText = 'display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem; background: rgba(34, 211, 238, 0.25); border: 1px solid rgba(34, 211, 238, 0.4); border-radius: 12px; color: #22d3ee; font-size: 0.7rem; white-space: nowrap;';
                        bubble.appendChild(document.createTextNode(`📚 ${displayName}`));
                        
                        const removeBtn = document.createElement('button');
                        removeBtn.className = 'bubble-remove';
                        removeBtn.style.cssText = 'background: none; border: none; color: #22d3ee; cursor: pointer; font-size: 0.8rem; padding: 0; line-height: 1;';
                        removeBtn.textContent = '×';
                        removeBtn.addEventListener('click', function(e) {
                            e.stopPropagation();
                            window.auditSelectedBooks.delete(fractalId);
                            renderSelectedBubbles();
                            renderDropdownList('');
                            updateBookContextDisplay();
                        });
                        bubble.appendChild(removeBtn);
                        fragment.appendChild(bubble);
                    });
                    bubblesDiv.replaceChildren(fragment);
                }
            };
            
            const renderDropdownList = (searchText) => {
                const dropdown = document.getElementById('auditBookDropdown');
                if (!dropdown) return;
                
                const filtered = window.auditAllBooks.filter(book => 
                    !window.auditSelectedBooks.has(book.fractal_id) &&
                    book.name.toLowerCase().includes(searchText.toLowerCase())
                );
                
                if (filtered.length === 0) {
                    const emptyDiv = document.createElement('div');
                    emptyDiv.style.cssText = 'padding: 0.5rem; color: #64748b; font-size: 0.75rem;';
                    emptyDiv.textContent = 'No unselected books found';
                    dropdown.replaceChildren(emptyDiv);
                } else {
                    const fragment = document.createDocumentFragment();
                    filtered.forEach(book => {
                        const item = document.createElement('div');
                        item.className = 'dropdown-book-item';
                        item.dataset.fractalId = book.fractal_id;
                        item.style.cssText = 'padding: 0.5rem 0.75rem; cursor: pointer; color: #e2e8f0; font-size: 0.8rem; border-bottom: 1px solid rgba(148, 163, 184, 0.1); transition: background 0.2s;';
                        item.textContent = `📚 ${book.name}`;
                        
                        item.addEventListener('click', function() {
                            window.auditSelectedBooks.add(book.fractal_id);
                            renderSelectedBubbles();
                            renderDropdownList('');
                            document.getElementById('bookSearchInput').value = '';
                            updateBookContextDisplay();
                        });
                        item.addEventListener('mouseover', function() {
                            this.style.background = 'rgba(148, 163, 184, 0.1)';
                        });
                        item.addEventListener('mouseout', function() {
                            this.style.background = 'transparent';
                        });
                        fragment.appendChild(item);
                    });
                    dropdown.replaceChildren(fragment);
                }
            };
            
            // Dropdown toggle
            const dropdown = document.getElementById('auditBookDropdown');
            const toggleBtn = document.getElementById('bookDropdownToggle');
            const searchInput = document.getElementById('bookSearchInput');
            
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
                    if (dropdown.style.display === 'block') renderDropdownList('');
                });
            }
            
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    dropdown.style.display = 'block';
                    renderDropdownList(e.target.value);
                });
                searchInput.addEventListener('focus', () => {
                    dropdown.style.display = 'block';
                });
            }
            
            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#bookSearchInput') && 
                    !e.target.closest('#bookDropdownToggle') && 
                    !e.target.closest('#auditBookDropdown')) {
                    dropdown.style.display = 'none';
                }
            });
            
            // All/None buttons
            const allBtn = document.getElementById('bookSelectAll');
            const noneBtn = document.getElementById('bookSelectNone');
            
            if (allBtn) {
                allBtn.addEventListener('click', () => {
                    window.auditSelectedBooks = new Set(window.auditAllBooks.map(b => b.fractal_id));
                    renderSelectedBubbles();
                    renderDropdownList('');
                    updateBookContextDisplay();
                });
            }
            
            if (noneBtn) {
                noneBtn.addEventListener('click', () => {
                    window.auditSelectedBooks.clear();
                    renderSelectedBubbles();
                    renderDropdownList('');
                    updateBookContextDisplay();
                });
            }
            
            // Initial render
            renderSelectedBubbles();
            renderDropdownList('');
            
            updateBookContextDisplay();
            auditModal.style.display = 'flex';
        }
        
        function updateBookContextDisplay() {
            const contextDiv = document.getElementById('nyanAuditBookContext');
            const selectedCount = window.auditSelectedBooks?.size || 0;
            const totalCount = books?.length || 0;
            
            if (contextDiv) {
                if (selectedCount === 0) {
                    contextDiv.textContent = `⚠️ No books selected - Nyan AI will answer without book context`;
                    contextDiv.style.background = 'rgba(245, 158, 11, 0.1)';
                    contextDiv.style.borderColor = 'rgba(245, 158, 11, 0.3)';
                    contextDiv.style.color = '#f59e0b';
                } else if (selectedCount === totalCount) {
                    contextDiv.textContent = `📚 Nyan AI: Searching ALL ${totalCount} book${totalCount !== 1 ? 's' : ''}`;
                    contextDiv.style.background = 'rgba(34, 211, 238, 0.1)';
                    contextDiv.style.borderColor = 'rgba(34, 211, 238, 0.3)';
                    contextDiv.style.color = '#22d3ee';
                } else {
                    contextDiv.textContent = `📚 Nyan AI: Searching ${selectedCount} of ${totalCount} book${totalCount !== 1 ? 's' : ''}`;
                    contextDiv.style.background = 'rgba(168, 85, 247, 0.1)';
                    contextDiv.style.borderColor = 'rgba(168, 85, 247, 0.3)';
                    contextDiv.style.color = '#a855f7';
                }
            }
        }
        
        function closeNyanAuditModal() {
            const modal = document.getElementById('nyanAuditModal');
            if (modal) modal.style.display = 'none';
        }
        
        function detectBookNamesInQuery(query) {
            if (!query || !books || books.length === 0) return [];
            const queryLower = query.toLowerCase();
            const matchedBooks = [];
            for (const book of books) {
                if (!book.name) continue;
                const bookNameLower = book.name.toLowerCase();
                // Use word boundary to match whole book names only (avoid matching substrings like "perbaikan" in "mengalami perbaikan")
                try {
                    const regex = new RegExp(`\\b${bookNameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    if (regex.test(queryLower)) {
                        matchedBooks.push({ fractalId: book.fractal_id, name: book.name });
                    }
                } catch (e) {
                    // Fallback to substring match if regex fails
                    if (queryLower.includes(bookNameLower)) {
                        matchedBooks.push({ fractalId: book.fractal_id, name: book.name });
                    }
                }
            }
            return matchedBooks;
        }
        
        async function runNyanAuditCheck() {
            const message = document.getElementById('nyanAuditMessage').value.trim();
            const btn = document.getElementById('nyanAuditCheckBtn');
            const resultContent = document.getElementById('nyanAuditResultContent');
            const selectedBookIds = window.auditSelectedBooks ? Array.from(window.auditSelectedBooks) : [];
            
            if (!message) {
                showToast('⚠️ Please enter a message to check', 'error');
                return;
            }
            
            btn.disabled = true;
            btn.textContent = '🌈 Analyzing...';
            
            const loadingDiv = document.createElement('div');
            loadingDiv.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 2rem 1rem;';
            const loadingIcon = document.createElement('div');
            loadingIcon.style.cssText = 'font-size: 2.5rem; margin-bottom: 0.75rem; animation: pulse 1.5s ease-in-out infinite;';
            loadingIcon.textContent = '🌈';
            loadingDiv.appendChild(loadingIcon);
            const loadingText = document.createElement('p');
            loadingText.style.cssText = 'margin: 0; color: #a855f7;';
            loadingText.textContent = 'Nyan AI analyzing your query...';
            loadingDiv.appendChild(loadingText);
            const loadingSubtext = document.createElement('p');
            loadingSubtext.style.cssText = 'margin: 0.5rem 0 0 0; color: #64748b; font-size: 0.75rem;';
            loadingSubtext.textContent = `Searching ${selectedBookIds.length} book${selectedBookIds.length !== 1 ? 's' : ''}`;
            loadingDiv.appendChild(loadingSubtext);
            resultContent.replaceChildren(loadingDiv);
            
            console.log(`🌈 Nyan AI: Querying ${selectedBookIds.length} book(s)`);
            
            try {
                const response = await window.authFetch('/api/nyan-ai/audit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        query: message,
                        bookIds: selectedBookIds
                    })
                });
                
                const data = await response.json();

                if (response.status === 503 && data.code === 'warming_up') {
                    const warmupDiv = document.createElement('div');
                    warmupDiv.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 2rem 1rem;';
                    const warmupIcon = document.createElement('div');
                    warmupIcon.style.cssText = 'font-size: 2.5rem; margin-bottom: 0.75rem; animation: pulse 1.5s ease-in-out infinite;';
                    warmupIcon.textContent = '🐱';
                    warmupDiv.appendChild(warmupIcon);
                    const warmupText = document.createElement('p');
                    warmupText.style.cssText = 'margin: 0; color: #a855f7;';
                    warmupText.textContent = 'Still warming up — retrying in 5 seconds...';
                    warmupDiv.appendChild(warmupText);
                    resultContent.replaceChildren(warmupDiv);
                    btn.disabled = false;
                    btn.textContent = '🔮 Run AI Check';
                    setTimeout(() => runNyanAuditCheck(), 5000);
                    return;
                }

                if (!response.ok) {
                    throw new Error(data.error || 'AI audit failed');
                }
                
                const bookInfo = data.bookContext 
                    ? `${data.bookContext.bookCount} book(s), ${data.bookContext.totalMessages} messages`
                    : 'No book context';
                
                const fragment = document.createDocumentFragment();
                
                const headerRow = document.createElement('div');
                headerRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap;';
                
                const nyanBadge = document.createElement('span');
                nyanBadge.style.cssText = 'font-size: 0.8rem; padding: 0.25rem 0.5rem; background: rgba(168, 85, 247, 0.2); border: 1px solid rgba(168, 85, 247, 0.4); border-radius: 4px; color: #a855f7; font-weight: 600;';
                nyanBadge.textContent = '🌈 Nyan AI';
                headerRow.appendChild(nyanBadge);
                
                const timeSpan = document.createElement('span');
                timeSpan.style.cssText = 'color: #64748b; font-size: 0.75rem;';
                timeSpan.textContent = `${data.processingTime}ms`;
                headerRow.appendChild(timeSpan);
                
                const bookSpan = document.createElement('span');
                bookSpan.style.cssText = 'color: #22d3ee; font-size: 0.75rem;';
                bookSpan.textContent = `📚 ${bookInfo}`;
                headerRow.appendChild(bookSpan);
                fragment.appendChild(headerRow);
                
                const answerBox = document.createElement('div');
                answerBox.style.cssText = 'padding: 0.75rem; background: linear-gradient(135deg, rgba(168, 85, 247, 0.08), rgba(236, 72, 153, 0.08)); border: 1px solid rgba(168, 85, 247, 0.25); border-radius: 8px; margin-bottom: 0.75rem;';
                const answerP = document.createElement('p');
                answerP.style.cssText = 'color: #e2e8f0; margin: 0; line-height: 1.6; font-size: 0.9rem; white-space: pre-wrap;';
                answerP.textContent = data.answer;
                answerBox.appendChild(answerP);
                fragment.appendChild(answerBox);
                
                const modelDiv = document.createElement('div');
                modelDiv.style.cssText = 'font-size: 0.7rem; color: #64748b; text-align: right;';
                modelDiv.textContent = `Model: ${data.model || 'deepseek-reasoner'}`;
                fragment.appendChild(modelDiv);
                
                resultContent.replaceChildren(fragment);
                showToast(`🌈 Nyan AI response complete`, 'success');
                
            } catch (error) {
                console.error('AI check error:', error);
                showToast(`⚠️ ${error.message}`, 'error');
                
                const errorDiv = document.createElement('div');
                errorDiv.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 2rem 1rem;';
                const errorIcon = document.createElement('div');
                errorIcon.style.cssText = 'font-size: 2rem; margin-bottom: 0.75rem;';
                errorIcon.textContent = '❌';
                errorDiv.appendChild(errorIcon);
                const errorText = document.createElement('p');
                errorText.style.cssText = 'color: #ef4444; margin: 0; font-size: 0.875rem;';
                const strong = document.createElement('strong');
                strong.textContent = 'Error: ';
                errorText.appendChild(strong);
                errorText.appendChild(document.createTextNode(error.message));
                errorDiv.appendChild(errorText);
                resultContent.replaceChildren(errorDiv);
            } finally {
                btn.disabled = false;
                btn.textContent = '🔮 Run AI Check';
            }
        }
        
        // AI Audit History Modal - View past audit queries
        function showNyanAuditHistoryModal() {
            let historyModal = document.getElementById('nyanAuditHistoryModal');
            if (!historyModal) {
                const modalHtml = `
                    <div id="nyanAuditHistoryModal" class="book-fan-modal" style="z-index: 10000;">
                        <div class="book-fan-content" style="max-width: 700px; padding: 2rem; max-height: 80vh; overflow-y: auto;">
                            <button class="book-fan-close" id="nyanAuditHistoryClose">×</button>
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem;">
                                <h3 style="font-size: 1.5rem; background: linear-gradient(135deg, #22d3ee, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin: 0;">🧠 Audit History</h3>
                                <button id="nyanAuditMirrorToggle" style="background: rgba(148, 163, 184, 0.1); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 6px; color: #94a3b8; padding: 0.375rem 0.625rem; cursor: pointer; font-size: 0.75rem; display: flex; align-items: center; gap: 0.375rem; transition: all 0.2s ease;" title="Configure audit mirror outpipe">🪞 Mirror</button>
                            </div>
                            <div id="nyanAuditMirrorPanel" style="display: none; padding: 1rem; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.15); border-radius: 8px; margin-bottom: 1rem;">
                                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                                    <span style="color: #e2e8f0; font-size: 0.875rem; font-weight: 600;">🪞 Audit Mirror — Webhook Outpipe</span>
                                </div>
                                <p style="color: #94a3b8; font-size: 0.75rem; margin-bottom: 0.5rem;">Mirror audit results to any webhook endpoint. Each audit log will be POSTed as JSON.</p>
                                <p style="color: #64748b; font-size: 0.65rem; margin-bottom: 0.75rem; line-height: 1.4;">Discord: Server Settings → Integrations → Webhooks → Copy URL<br/>Generic: Any HTTPS endpoint that accepts POST requests</p>
                                <div style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap;">
                                    <input type="url" id="nyanAuditMirrorInput" placeholder="https://discord.com/api/webhooks/... or https://yourapp.com/hook" style="flex: 1; min-width: 0; background: rgba(148, 163, 184, 0.1); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 6px; color: #e2e8f0; padding: 0.5rem 0.75rem; font-size: 0.8rem; outline: none;" />
                                    <button id="nyanAuditMirrorSave" style="background: linear-gradient(135deg, #3b82f6, #2563eb); border: none; border-radius: 6px; color: white; padding: 0.5rem 0.75rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; white-space: nowrap;">Save</button>
                                </div>
                                <div id="nyanAuditMirrorStatus" style="font-size: 0.7rem; color: #64748b;"></div>
                                <button id="nyanAuditMirrorRemove" style="display: none; margin-top: 0.5rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px; color: #ef4444; padding: 0.375rem 0.625rem; cursor: pointer; font-size: 0.7rem;">Remove Mirror</button>
                            </div>
                            
                            <div id="nyanAuditHistoryContent" style="min-height: 200px;">
                                <div style="text-align: center; padding: 2rem; color: #94a3b8;">
                                    Loading history...
                                </div>
                            </div>
                            
                            <div id="nyanAuditHistoryPagination" style="display: flex; justify-content: center; gap: 1rem; margin-top: 1rem;"></div>
                        </div>
                    </div>
                `;
                document.body.insertAdjacentHTML('beforeend', modalHtml);
                historyModal = document.getElementById('nyanAuditHistoryModal');
                
                historyModal.addEventListener('click', function(e) {
                    if (e.target === this) closeNyanAuditHistoryModal();
                });
                document.getElementById('nyanAuditHistoryClose').addEventListener('click', closeNyanAuditHistoryModal);
                
                const mirrorToggle = document.getElementById('nyanAuditMirrorToggle');
                const mirrorPanel = document.getElementById('nyanAuditMirrorPanel');
                mirrorToggle.addEventListener('click', () => {
                    const visible = mirrorPanel.style.display !== 'none';
                    mirrorPanel.style.display = visible ? 'none' : 'block';
                    mirrorToggle.style.borderColor = visible ? 'rgba(148, 163, 184, 0.2)' : 'rgba(59, 130, 246, 0.4)';
                    mirrorToggle.style.color = visible ? '#94a3b8' : '#60a5fa';
                    if (!visible) loadAuditMirrorConfig();
                });
                
                document.getElementById('nyanAuditMirrorSave').addEventListener('click', saveAuditMirrorConfig);
                document.getElementById('nyanAuditMirrorRemove').addEventListener('click', removeAuditMirrorConfig);
            }
            
            historyModal.style.display = 'flex';
            loadNyanAuditHistory(50);
        }
        
        function closeNyanAuditHistoryModal() {
            const modal = document.getElementById('nyanAuditHistoryModal');
            if (modal) modal.style.display = 'none';
        }
        
        async function loadAuditMirrorConfig() {
            const statusEl = document.getElementById('nyanAuditMirrorStatus');
            const inputEl = document.getElementById('nyanAuditMirrorInput');
            const removeBtn = document.getElementById('nyanAuditMirrorRemove');
            try {
                const response = await window.authFetch('/api/nyan-ai/audit-mirror');
                if (response.ok) {
                    const data = await response.json();
                    if (data.audit_mirror_webhook_url) {
                        inputEl.value = data.audit_mirror_webhook_url;
                        const isDiscord = /discord\.com\/api\/webhooks\//.test(data.audit_mirror_webhook_url);
                        statusEl.textContent = `Active — ${isDiscord ? 'Discord webhook' : 'webhook'} configured`;
                        statusEl.style.color = '#10b981';
                        removeBtn.style.display = 'inline-block';
                    } else if (data.legacy_thread_only) {
                        inputEl.value = '';
                        statusEl.innerHTML = `Legacy mirror (thread ${data.audit_mirror_thread_id}) — <span style="color:#f59e0b">enter a webhook URL to upgrade</span>`;
                        statusEl.style.color = '#f59e0b';
                        removeBtn.style.display = 'inline-block';
                    } else {
                        inputEl.value = '';
                        statusEl.textContent = 'No mirror configured';
                        statusEl.style.color = '#64748b';
                        removeBtn.style.display = 'none';
                    }
                }
            } catch (err) {
                statusEl.textContent = 'Failed to load mirror config';
                statusEl.style.color = '#ef4444';
            }
        }
        
        async function saveAuditMirrorConfig() {
            const inputEl = document.getElementById('nyanAuditMirrorInput');
            const statusEl = document.getElementById('nyanAuditMirrorStatus');
            const webhookUrl = inputEl.value.trim();
            if (!webhookUrl) {
                statusEl.textContent = 'Please enter a webhook URL';
                statusEl.style.color = '#f59e0b';
                return;
            }
            if (!/^https?:\/\/.+/.test(webhookUrl)) {
                statusEl.textContent = 'URL must start with https:// or http://';
                statusEl.style.color = '#ef4444';
                return;
            }
            statusEl.textContent = 'Saving...';
            statusEl.style.color = '#94a3b8';
            try {
                const response = await window.authFetch('/api/nyan-ai/audit-mirror', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ webhook_url: webhookUrl })
                });
                if (response.ok) {
                    const isDiscord = /discord\.com\/api\/webhooks\//.test(webhookUrl);
                    statusEl.textContent = `Mirror active — ${isDiscord ? 'Discord webhook' : 'webhook'} saved`;
                    statusEl.style.color = '#10b981';
                    document.getElementById('nyanAuditMirrorRemove').style.display = 'inline-block';
                } else {
                    const err = await response.json();
                    statusEl.textContent = err.error || 'Failed to save';
                    statusEl.style.color = '#ef4444';
                }
            } catch (err) {
                statusEl.textContent = 'Network error';
                statusEl.style.color = '#ef4444';
            }
        }
        
        async function removeAuditMirrorConfig() {
            const statusEl = document.getElementById('nyanAuditMirrorStatus');
            const inputEl = document.getElementById('nyanAuditMirrorInput');
            const removeBtn = document.getElementById('nyanAuditMirrorRemove');
            statusEl.textContent = 'Removing...';
            statusEl.style.color = '#94a3b8';
            try {
                const response = await window.authFetch('/api/nyan-ai/audit-mirror', { method: 'DELETE' });
                if (response.ok) {
                    inputEl.value = '';
                    statusEl.textContent = 'Mirror removed';
                    statusEl.style.color = '#64748b';
                    removeBtn.style.display = 'none';
                } else {
                    statusEl.textContent = 'Failed to remove';
                    statusEl.style.color = '#ef4444';
                }
            } catch (err) {
                statusEl.textContent = 'Network error';
                statusEl.style.color = '#ef4444';
            }
        }
        
        async function loadNyanAuditHistory(limit = 50) {
            const contentDiv = document.getElementById('nyanAuditHistoryContent');
            const paginationDiv = document.getElementById('nyanAuditHistoryPagination');
            
            try {
                const response = await window.authFetch(`/api/nyan-ai/discord-history?limit=${limit}`);
                
                if (!response.ok) {
                    const text = await response.text();
                    let errorMsg = 'Failed to load history';
                    try {
                        const errData = JSON.parse(text);
                        errorMsg = errData.error || errorMsg;
                    } catch (e) {
                        errorMsg = `Server error (${response.status})`;
                    }
                    throw new Error(errorMsg);
                }
                
                const data = await response.json();
                
                if (data.message || !data.logs || data.logs.length === 0) {
                    const emptyDiv = document.createElement('div');
                    emptyDiv.style.cssText = 'text-align: center; padding: 2rem; color: #94a3b8;';
                    const iconDiv = document.createElement('div');
                    iconDiv.style.cssText = 'font-size: 3rem; margin-bottom: 1rem;';
                    iconDiv.textContent = '👁️';
                    emptyDiv.appendChild(iconDiv);
                    const p1 = document.createElement('p');
                    p1.textContent = 'No audit history yet.';
                    emptyDiv.appendChild(p1);
                    const p2 = document.createElement('p');
                    p2.style.cssText = 'font-size: 0.875rem; margin-top: 0.5rem;';
                    p2.textContent = 'Run your first AI check to see results here.';
                    emptyDiv.appendChild(p2);
                    contentDiv.replaceChildren(emptyDiv);
                    paginationDiv.replaceChildren();
                    return;
                }
                
                const statusColors = {
                    'PASS': '#10b981',
                    'FAIL': '#ef4444',
                    'WARNING': '#f59e0b',
                    'REVIEW': '#6366f1'
                };
                
                const buildStatsDiv = () => {
                    if (!data.stats || data.stats.total === 0) return null;
                    const statsDiv = document.createElement('div');
                    statsDiv.style.cssText = 'display: flex; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap;';
                    
                    const statItems = [
                        { icon: '✅', label: 'Pass', value: data.stats.pass, bg: 'rgba(16, 185, 129, 0.15)', border: 'rgba(16, 185, 129, 0.3)', color: '#10b981' },
                        { icon: '❌', label: 'Fail', value: data.stats.fail, bg: 'rgba(239, 68, 68, 0.15)', border: 'rgba(239, 68, 68, 0.3)', color: '#ef4444' },
                        { icon: '⚠️', label: 'Warning', value: data.stats.warning, bg: 'rgba(245, 158, 11, 0.15)', border: 'rgba(245, 158, 11, 0.3)', color: '#f59e0b' },
                        { icon: '🔍', label: 'Review', value: data.stats.review, bg: 'rgba(99, 102, 241, 0.15)', border: 'rgba(99, 102, 241, 0.3)', color: '#6366f1' },
                        { icon: '🎯', label: 'Avg', value: `${data.stats.averageConfidence}%`, bg: 'rgba(148, 163, 184, 0.15)', border: 'rgba(148, 163, 184, 0.3)', color: '#94a3b8' }
                    ];
                    
                    statItems.forEach(item => {
                        const el = document.createElement('div');
                        el.style.cssText = `padding: 0.5rem 0.75rem; background: ${item.bg}; border: 1px solid ${item.border}; border-radius: 6px; color: ${item.color}; font-size: 0.8rem;`;
                        el.textContent = `${item.icon} ${item.label}: ${item.value}`;
                        statsDiv.appendChild(el);
                    });
                    return statsDiv;
                };
                
                const isSourceTruncated = (text) => {
                    if (!text || text === 'No answer') return false;
                    if (text.endsWith('...')) return true;
                    if (text.length >= 490 && !/[.!?\n]$/.test(text.trim())) return true;
                    return false;
                };

                const buildLogItem = (log) => {
                    const parsed = log.parsed || {};
                    const status = parsed.status?.toUpperCase() || 'UNKNOWN';
                    const statusColor = statusColors[status] || '#94a3b8';
                    const date = new Date(log.timestamp).toLocaleString();
                    const query = parsed.query || log.content || 'No query';
                    const answer = parsed.answer || 'No answer';
                    const confidence = parsed.confidence;
                    const bookContext = parsed.bookContext;
                    const queryNeedsTruncation = query.length > 150;
                    const answerNeedsTruncation = answer.length > 200;
                    const expandable = queryNeedsTruncation || answerNeedsTruncation;
                    let expanded = false;
                    
                    const card = document.createElement('div');
                    card.className = 'audit-log-card';
                    card.style.cssText = 'padding: 1rem; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.15); border-radius: 8px; margin-bottom: 0.75rem; transition: border-color 0.2s ease, background 0.2s ease;' + (expandable ? 'cursor: pointer;' : '');
                    
                    const headerRow = document.createElement('div');
                    headerRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;';
                    
                    const leftGroup = document.createElement('div');
                    leftGroup.style.cssText = 'display: flex; align-items: center; gap: 0.75rem;';
                    const statusBadge = document.createElement('span');
                    statusBadge.style.cssText = `padding: 0.25rem 0.5rem; background: ${statusColor}20; border: 1px solid ${statusColor}; border-radius: 4px; color: ${statusColor}; font-weight: 600; font-size: 0.75rem;`;
                    statusBadge.textContent = status;
                    leftGroup.appendChild(statusBadge);
                    
                    if (bookContext) {
                        const bookSpan = document.createElement('span');
                        bookSpan.style.cssText = 'color: #60a5fa; font-size: 0.75rem;';
                        bookSpan.textContent = `📚 ${bookContext}`;
                        leftGroup.appendChild(bookSpan);
                    }
                    headerRow.appendChild(leftGroup);
                    
                    const rightGroup = document.createElement('div');
                    rightGroup.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';
                    const dateSpan = document.createElement('span');
                    dateSpan.style.cssText = 'color: #64748b; font-size: 0.75rem;';
                    dateSpan.textContent = date;
                    rightGroup.appendChild(dateSpan);
                    if (expandable) {
                        const expandIcon = document.createElement('span');
                        expandIcon.style.cssText = 'color: #64748b; font-size: 0.65rem; transition: transform 0.2s ease;';
                        expandIcon.textContent = '▼';
                        expandIcon.className = 'audit-expand-icon';
                        rightGroup.appendChild(expandIcon);
                    }
                    headerRow.appendChild(rightGroup);
                    card.appendChild(headerRow);
                    
                    const bodyWrap = document.createElement('div');
                    bodyWrap.style.cssText = 'overflow: hidden; transition: max-height 0.3s ease;';
                    
                    const queryDiv = document.createElement('div');
                    queryDiv.style.cssText = 'color: #94a3b8; font-size: 0.875rem; margin-bottom: 0.5rem;';
                    const queryStrong = document.createElement('strong');
                    queryStrong.textContent = 'Query: ';
                    queryDiv.appendChild(queryStrong);
                    const queryText = document.createElement('span');
                    queryText.textContent = queryNeedsTruncation ? query.substring(0, 150) + '...' : query;
                    queryDiv.appendChild(queryText);
                    bodyWrap.appendChild(queryDiv);
                    
                    const answerDiv = document.createElement('div');
                    answerDiv.style.cssText = 'color: #e2e8f0; font-size: 0.875rem;';
                    const answerStrong = document.createElement('strong');
                    answerStrong.textContent = 'Answer: ';
                    answerDiv.appendChild(answerStrong);
                    const answerText = document.createElement('span');
                    answerText.textContent = answerNeedsTruncation ? answer.substring(0, 200) + '...' : answer;
                    answerDiv.appendChild(answerText);
                    bodyWrap.appendChild(answerDiv);
                    
                    const truncatedIndicator = document.createElement('div');
                    truncatedIndicator.style.cssText = 'display: none; color: #f59e0b; font-size: 0.7rem; margin-top: 0.375rem; font-style: italic;';
                    truncatedIndicator.textContent = '⚠ response truncated at source';
                    bodyWrap.appendChild(truncatedIndicator);
                    
                    card.appendChild(bodyWrap);
                    
                    if (confidence) {
                        const confDiv = document.createElement('div');
                        confDiv.style.cssText = 'color: #64748b; font-size: 0.75rem; margin-top: 0.5rem;';
                        confDiv.textContent = `Confidence: ${confidence}%`;
                        card.appendChild(confDiv);
                    }
                    
                    if (expandable) {
                        requestAnimationFrame(() => {
                            bodyWrap.style.maxHeight = bodyWrap.scrollHeight + 'px';
                        });
                        card.addEventListener('click', (e) => {
                            e.stopPropagation();
                            expanded = !expanded;
                            const icon = card.querySelector('.audit-expand-icon');
                            if (expanded) {
                                queryText.textContent = query;
                                answerText.textContent = answer;
                                if (isSourceTruncated(answer)) {
                                    truncatedIndicator.style.display = 'block';
                                }
                                card.style.borderColor = 'rgba(59, 130, 246, 0.3)';
                                card.style.background = 'rgba(15, 23, 42, 0.8)';
                                if (icon) icon.style.transform = 'rotate(180deg)';
                                bodyWrap.style.maxHeight = bodyWrap.scrollHeight + 'px';
                            } else {
                                queryText.textContent = queryNeedsTruncation ? query.substring(0, 150) + '...' : query;
                                answerText.textContent = answerNeedsTruncation ? answer.substring(0, 200) + '...' : answer;
                                truncatedIndicator.style.display = 'none';
                                card.style.borderColor = 'rgba(148, 163, 184, 0.15)';
                                card.style.background = 'rgba(15, 23, 42, 0.6)';
                                if (icon) icon.style.transform = 'rotate(0deg)';
                                bodyWrap.style.maxHeight = bodyWrap.scrollHeight + 'px';
                            }
                        });
                    }
                    
                    return card;
                };
                
                const fragment = document.createDocumentFragment();
                const statsDiv = buildStatsDiv();
                if (statsDiv) fragment.appendChild(statsDiv);
                data.logs.forEach(log => fragment.appendChild(buildLogItem(log)));
                contentDiv.replaceChildren(fragment);
                
                const paginationSpan = document.createElement('span');
                paginationSpan.style.cssText = 'color: #64748b; font-size: 0.75rem;';
                paginationSpan.textContent = `👁️ Powered by Horus | Showing ${data.logs.length} logs`;
                paginationDiv.replaceChildren(paginationSpan);
                
            } catch (error) {
                console.error('Failed to load Nyan AI audit history:', error);
                const errDiv = document.createElement('div');
                errDiv.style.cssText = 'text-align: center; padding: 2rem; color: #ef4444;';
                const errIcon = document.createElement('div');
                errIcon.style.cssText = 'font-size: 2rem; margin-bottom: 0.5rem;';
                errIcon.textContent = '⚠️';
                errDiv.appendChild(errIcon);
                const errP = document.createElement('p');
                errP.textContent = error.message;
                errDiv.appendChild(errP);
                contentDiv.replaceChildren(errDiv);
                paginationDiv.replaceChildren();
            }
        }
        
        // Book Info Modal (Read-only: Show webhook0n data only)
        // ARCHITECTURAL: Display user's webhook (output_0n) info, hide the silent cat (webhook01)
        function showBookInfoModal() {
            // Get current book
            const currentBookId = document.querySelector('.discord-messages-container')?.id?.replace('discord-messages-', '');
            if (!currentBookId) {
                showToast('⚠️ No book selected', 'error');
                return;
            }
            
            const activeBooks = filteredBooks.length > 0 ? filteredBooks : books;
            const currentBook = activeBooks.find(b => b.fractal_id === currentBookId);
            
            if (!currentBook) {
                showToast('⚠️ Book not found', 'error');
                return;
            }
            
            // Create modal (genesis form style, but read-only)
            let bookInfoModal = document.getElementById('bookInfoModal');
            if (!bookInfoModal) {
                const modalHtml = `
                    <div id="bookInfoModal" class="book-fan-modal" style="z-index: 10000;">
                        <div class="book-fan-content" style="max-width: 500px; padding: 2rem;">
                            <button class="book-fan-close" id="bookInfoClose">×</button>
                            <h3 style="margin-bottom: 1.5rem; font-size: 1.5rem; background: linear-gradient(135deg, #a855f7, #ec4899, #f59e0b, #10b981, #3b82f6, #6366f1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">ℹ️ Book Information</h3>
                            <div id="bookInfoContent"></div>
                        </div>
                    </div>
                `;
                document.body.insertAdjacentHTML('beforeend', modalHtml);
                bookInfoModal = document.getElementById('bookInfoModal');
                
                // Add event listeners
                bookInfoModal.addEventListener('click', function(e) {
                    if (e.target === this) closeBookInfoModal();
                });
                document.getElementById('bookInfoClose').addEventListener('click', closeBookInfoModal);
            }
            
            // Build read-only info display (only webhook0n data, NOT webhook01)
            const webhookUrl = currentBook.output_0n_url || 'Not configured';
            const status = currentBook.status || 'unknown';
            const statusColor = status === 'active' ? '#10b981' : status === 'inactive' ? '#94a3b8' : '#ef4444';
            const platform = currentBook.input_platform || 'Unknown';
            const tags = currentBook.tags || [];
            
            // Helper to create a form group
            const createFormGroup = (labelText, valueContent, extraStyles = '') => {
                const group = document.createElement('div');
                group.className = 'form-group';
                
                const label = document.createElement('label');
                label.className = 'form-label';
                label.textContent = labelText;
                group.appendChild(label);
                
                const valueDiv = document.createElement('div');
                valueDiv.style.cssText = 'padding: 0.75rem; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; color: #e2e8f0;' + extraStyles;
                
                if (typeof valueContent === 'string') {
                    valueDiv.textContent = valueContent;
                } else if (valueContent instanceof Node) {
                    valueDiv.appendChild(valueContent);
                }
                group.appendChild(valueDiv);
                
                return group;
            };
            
            const container = document.createElement('div');
            container.style.cssText = 'display: flex; flex-direction: column; gap: 1rem;';
            
            // Book Name
            container.appendChild(createFormGroup('Book Name', currentBook.name));
            
            // Webhook URL
            const webhookGroup = document.createElement('div');
            webhookGroup.className = 'form-group';
            const webhookLabel = document.createElement('label');
            webhookLabel.className = 'form-label';
            webhookLabel.textContent = 'Your Webhook';
            webhookGroup.appendChild(webhookLabel);
            const webhookValueDiv = document.createElement('div');
            webhookValueDiv.style.cssText = 'padding: 0.75rem; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; color: #e2e8f0; word-break: break-all; font-size: 0.875rem;';
            if (webhookUrl === 'Not configured') {
                const span = document.createElement('span');
                span.style.color = '#94a3b8';
                span.textContent = 'Not configured';
                webhookValueDiv.appendChild(span);
            } else {
                webhookValueDiv.textContent = webhookUrl;
            }
            webhookGroup.appendChild(webhookValueDiv);
            container.appendChild(webhookGroup);
            
            // Status
            const statusGroup = document.createElement('div');
            statusGroup.className = 'form-group';
            const statusLabel = document.createElement('label');
            statusLabel.className = 'form-label';
            statusLabel.textContent = 'Status';
            statusGroup.appendChild(statusLabel);
            const statusValueDiv = document.createElement('div');
            statusValueDiv.style.cssText = `padding: 0.75rem; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; color: ${statusColor}; text-transform: capitalize; font-weight: 500;`;
            statusValueDiv.textContent = status;
            statusGroup.appendChild(statusValueDiv);
            container.appendChild(statusGroup);
            
            // Tags (if any)
            if (tags.length > 0) {
                const tagsGroup = document.createElement('div');
                tagsGroup.className = 'form-group';
                const tagsLabel = document.createElement('label');
                tagsLabel.className = 'form-label';
                tagsLabel.textContent = 'Tags';
                tagsGroup.appendChild(tagsLabel);
                const tagsValueDiv = document.createElement('div');
                tagsValueDiv.style.cssText = 'padding: 0.75rem; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; display: flex; flex-wrap: wrap; gap: 0.5rem;';
                tags.forEach(tag => {
                    const tagSpan = document.createElement('span');
                    tagSpan.style.cssText = 'padding: 0.25rem 0.75rem; background: rgba(168, 85, 247, 0.2); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 12px; color: #c084fc; font-size: 0.875rem;';
                    tagSpan.textContent = tag;
                    tagsValueDiv.appendChild(tagSpan);
                });
                tagsGroup.appendChild(tagsValueDiv);
                container.appendChild(tagsGroup);
            }
            
            document.getElementById('bookInfoContent').replaceChildren(container);
            bookInfoModal.style.display = 'flex';
        }
        
        function closeBookInfoModal() {
            const modal = document.getElementById('bookInfoModal');
            if (modal) modal.style.display = 'none';
        }
        
        // Edit Book Modal
        function showEditBookModal(book) {
            editBook(book.fractal_id);
        }
        
        // Delete Book Confirmation
        function showDeleteBookConfirmation(book) {
            confirmDeleteBook(book.fractal_id);
        }
        
        // Book Fan Modal (Mobile: Show all books + utility actions)
        function showBookFanModal() {
            let bookFanModal = document.getElementById('bookFanModal');
            if (!bookFanModal) {
                // Create modal if it doesn't exist
                const modalHtml = `
                    <div id="bookFanModal" class="book-fan-modal">
                        <div class="book-fan-content">
                            <button class="book-fan-close">×</button>
                            <h3>🌉 All Books</h3>
                            <div class="book-fan-list" id="bookFanList"></div>
                            <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(148, 163, 184, 0.2);">
                                ${Object.values(ACTION_REGISTRY)
                                    .filter(action => ['search', 'audit'].includes(action.id))
                                    .map(action => `
                                        <div class="book-fan-item" data-action="${action.id}" style="opacity: 0.9;">
                                            <span class="book-fan-item-name">${action.icon} ${action.tooltip}</span>
                                            <span class="book-fan-item-arrow">→</span>
                                        </div>
                                    `).join('')}
                            </div>
                        </div>
                    </div>
                `;
                document.body.insertAdjacentHTML('beforeend', modalHtml);
                
                // Add event listeners
                bookFanModal = document.getElementById('bookFanModal');
                
                // Close on backdrop click
                bookFanModal.addEventListener('click', function(e) {
                    if (e.target === this) closeBookFanModal();
                });
                
                // Close button
                const closeBtn = bookFanModal.querySelector('.book-fan-close');
                if (closeBtn) closeBtn.addEventListener('click', closeBookFanModal);
                
                // UNIFIED EVENT DELEGATION: Handle clicks on book cards and action items
                bookFanModal.addEventListener('click', function(e) {
                    const item = e.target.closest('.book-fan-item');
                    if (!item) return;
                    
                    const bookId = item.dataset.bookId;
                    const action = item.dataset.action;
                    
                    console.log('🔘 Book card clicked:', { bookId, action });
                    
                    closeBookFanModal();
                    
                    if (bookId) {
                        // Book navigation
                        console.log('📱 Switching to book:', bookId);
                        selectBook(bookId);
                    } else if (ACTION_REGISTRY[action]) {
                        // Registry-based actions (unified with desktop/mobile)
                        console.log('⚡ Executing action:', action);
                        executeAction(action);
                    }
                });
            }
            
            // Render book list
            const fanList = document.getElementById('bookFanList');
            const activeBooks = filteredBooks.length > 0 ? filteredBooks : books;
            
            const fragment = document.createDocumentFragment();
            activeBooks.forEach((book, index) => {
                const item = document.createElement('div');
                item.className = 'book-fan-item';
                item.dataset.bookId = book.fractal_id;
                
                const nameSpan = document.createElement('span');
                nameSpan.className = 'book-fan-item-name';
                nameSpan.textContent = `${index + 1}. ${book.name}`;
                item.appendChild(nameSpan);
                
                const arrowSpan = document.createElement('span');
                arrowSpan.className = 'book-fan-item-arrow';
                arrowSpan.textContent = '→';
                item.appendChild(arrowSpan);
                
                fragment.appendChild(item);
            });
            fanList.replaceChildren(fragment);
            
            bookFanModal.classList.add('active');
        }
        
        function closeBookFanModal() {
            const bookFanModal = document.getElementById('bookFanModal');
            if (bookFanModal) bookFanModal.classList.remove('active');
        }

        // Universal search state - shared across all search boxes
        // Natural Language Date Parser with Excel format support
        function parseNaturalLanguageDate(query) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            const patterns = {
                'today': { start: new Date(today), end: new Date(today) },
                'yesterday': { 
                    start: new Date(today.getTime() - 86400000), 
                    end: new Date(today.getTime() - 86400000) 
                },
                'this week': {
                    start: new Date(today.getTime() - (today.getDay() * 86400000)),
                    end: new Date(today)
                },
                'last week': {
                    start: new Date(today.getTime() - ((today.getDay() + 7) * 86400000)),
                    end: new Date(today.getTime() - (today.getDay() * 86400000))
                },
                'this month': {
                    start: new Date(today.getFullYear(), today.getMonth(), 1),
                    end: new Date(today)
                },
                'last month': {
                    start: new Date(today.getFullYear(), today.getMonth() - 1, 1),
                    end: new Date(today.getFullYear(), today.getMonth(), 0)
                },
                'last 7 days': {
                    start: new Date(today.getTime() - (7 * 86400000)),
                    end: new Date(today)
                },
                'last 30 days': {
                    start: new Date(today.getTime() - (30 * 86400000)),
                    end: new Date(today)
                }
            };
            
            const lowerQuery = query.toLowerCase().trim();
            
            // Helper to format dates in local timezone
            const formatDate = (d) => {
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            };
            
            const months = {
                'january': 0, 'jan': 0,
                'february': 1, 'feb': 1,
                'march': 2, 'mar': 2,
                'april': 3, 'apr': 3,
                'may': 4,
                'june': 5, 'jun': 5,
                'july': 6, 'jul': 6,
                'august': 7, 'aug': 7,
                'september': 8, 'sep': 8, 'sept': 8,
                'october': 9, 'oct': 9,
                'november': 10, 'nov': 10,
                'december': 11, 'dec': 11
            };
            
            // Excel Format 1: MMM-YY (e.g., "Oct-24", "Jan-25")
            const mmmYYMatch = lowerQuery.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s-]?(\d{2})\b/i);
            if (mmmYYMatch) {
                const monthName = mmmYYMatch[1].toLowerCase();
                const yearShort = parseInt(mmmYYMatch[2]);
                const year = yearShort >= 0 && yearShort <= 50 ? 2000 + yearShort : 1900 + yearShort;
                const monthIndex = months[monthName];
                
                if (monthIndex !== undefined) {
                    const startDate = new Date(year, monthIndex, 1);
                    const endDate = new Date(year, monthIndex + 1, 0);
                    
                    return {
                        dateFrom: formatDate(startDate),
                        dateTo: formatDate(endDate),
                        context: `${monthName} ${year}`
                    };
                }
            }
            
            // Excel Format 2: DD-MMM-YY (e.g., "28-Oct-24", "15-Jan-25")
            const ddMmmYYMatch = lowerQuery.match(/\b(\d{1,2})[\s-](jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s-](\d{2,4})\b/i);
            if (ddMmmYYMatch) {
                const day = parseInt(ddMmmYYMatch[1]);
                const monthName = ddMmmYYMatch[2].toLowerCase();
                let year = parseInt(ddMmmYYMatch[3]);
                if (year < 100) {
                    year = year >= 0 && year <= 50 ? 2000 + year : 1900 + year;
                }
                const monthIndex = months[monthName];
                
                if (monthIndex !== undefined) {
                    const targetDate = new Date(year, monthIndex, day);
                    
                    return {
                        dateFrom: formatDate(targetDate),
                        dateTo: formatDate(targetDate),
                        context: `${day} ${monthName} ${year}`
                    };
                }
            }
            
            // Excel Format 3: YYYY-MM-DD (ISO format, e.g., "2024-10-28")
            const isoMatch = lowerQuery.match(/\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\b/);
            if (isoMatch) {
                const year = parseInt(isoMatch[1]);
                const month = parseInt(isoMatch[2]) - 1;
                const day = parseInt(isoMatch[3]);
                const targetDate = new Date(year, month, day);
                
                return {
                    dateFrom: formatDate(targetDate),
                    dateTo: formatDate(targetDate),
                    context: formatDate(targetDate)
                };
            }
            
            // Excel Format 4: MM/DD/YYYY or DD/MM/YYYY (e.g., "10/28/2024")
            const slashMatch = lowerQuery.match(/\b(\d{1,2})[\/](\d{1,2})[\/](20\d{2})\b/);
            if (slashMatch) {
                const first = parseInt(slashMatch[1]);
                const second = parseInt(slashMatch[2]);
                const year = parseInt(slashMatch[3]);
                
                // Try MM/DD/YYYY first (US format)
                let targetDate = new Date(year, first - 1, second);
                
                // If month is > 12, it must be DD/MM/YYYY
                if (first > 12) {
                    targetDate = new Date(year, second - 1, first);
                }
                
                return {
                    dateFrom: formatDate(targetDate),
                    dateTo: formatDate(targetDate),
                    context: formatDate(targetDate)
                };
            }
            
            // Try to match month patterns (e.g., "october", "in october", "october 2025")
            for (const [monthName, monthIndex] of Object.entries(months)) {
                const monthRegex = new RegExp(`\\b${monthName}\\b`, 'i');
                if (monthRegex.test(lowerQuery)) {
                    // Extract year if present (e.g., "october 2024", "2024 october")
                    const yearMatch = lowerQuery.match(/\b(20\d{2})\b/);
                    const year = yearMatch ? parseInt(yearMatch[1]) : today.getFullYear();
                    
                    const startDate = new Date(year, monthIndex, 1);
                    const endDate = new Date(year, monthIndex + 1, 0);
                    
                    return {
                        dateFrom: formatDate(startDate),
                        dateTo: formatDate(endDate),
                        context: yearMatch ? `${monthName} ${year}` : monthName
                    };
                }
            }
            
            // Check for standard patterns
            for (const [pattern, dates] of Object.entries(patterns)) {
                if (lowerQuery.includes(pattern)) {
                    return {
                        dateFrom: formatDate(dates.start),
                        dateTo: formatDate(dates.end),
                        context: pattern
                    };
                }
            }
            
            return null;
        }

        window.searchState = {
            regexMode: false,
            dateContext: null,
            performSearch: function(query, text, caseSensitive = false) {
                if (!query) return true;
                
                // Auto-detect regex pattern (starts with / or contains regex special chars)
                const isLikelyRegex = query.startsWith('/') || /[\[\](){}.*+?^$|\\]/.test(query);
                
                if (isLikelyRegex) {
                    try {
                        const cleanPattern = query.startsWith('/') ? query.slice(1, query.lastIndexOf('/') || query.length) : query;
                        const flags = caseSensitive ? '' : 'i';
                        const regex = new RegExp(cleanPattern, flags);
                        return regex.test(text);
                    } catch (e) {
                        // Invalid regex, fall back to literal search
                        return caseSensitive ? 
                            text.includes(query) : 
                            text.toLowerCase().includes(query.toLowerCase());
                    }
                } else {
                    return caseSensitive ? 
                        text.includes(query) : 
                        text.toLowerCase().includes(query.toLowerCase());
                }
            }
        };

        // Debounce function for search
        let searchDebounceTimer = null;
        function debouncedFilterBots() {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                filterBots();
            }, 300); // 300ms debounce
        }

        // UNIVERSAL SEARCH: Extract searchable text from book's cached messages
        // SECURITY: bookId MUST be fractal_id to maintain tenant isolation
        function getMessageSearchText(bookId) {
            // SECURITY: Validate fractal_id format before cache access
            if (!bookId || !(window.Nyan.BOOK_ID_PATTERN || /^(?:dev_)?(bridge|book|msg)_t\d+_[a-f0-9]+$|^twilio_book_\d+_\d+$/).test(bookId)) {
                console.error('🚨 SECURITY: Attempted cache access with invalid book ID');
                return '';
            }
            
            const messages = messageCache[bookId];
            if (!messages || !Array.isArray(messages)) return '';
            
            // Extract all searchable content from messages (matching Discord message search)
            return messages.map(msg => {
                const parts = [
                    msg.sender_name || '',
                    msg.message_content || '',
                    msg.sender_contact || '',
                    msg.media_type || '',           // Include media type (e.g. file info)
                    extractEmbedSearchText(msg.embeds)
                ];
                return parts.join(' ');
            }).join(' ').toLowerCase();
        }

        // Track server-side search state to avoid duplicate requests
        let serverSearchPending = false;
        let lastServerSearchTerm = '';
        
        async function filterBots() {
            const searchTerm = document.getElementById('searchBox').value;
            const platformFilter = document.getElementById('platformFilter')?.value || '';
            const messageTypeFilter = document.getElementById('messageTypeFilter')?.value || '';
            
            // Parse natural language dates from search query
            const naturalDateRange = parseNaturalLanguageDate(searchTerm);
            const contextBadge = document.getElementById('searchContextBadge');
            
            if (naturalDateRange) {
                // Show context badge
                if (contextBadge) {
                    contextBadge.textContent = `📅 ${naturalDateRange.context}`;
                    contextBadge.style.display = 'block';
                }
                window.searchState.dateContext = naturalDateRange;
                console.log('🔍 Natural language date detected:', naturalDateRange);
            } else {
                // Hide context badge
                if (contextBadge) {
                    contextBadge.style.display = 'none';
                }
                window.searchState.dateContext = null;
            }
            
            // EXHAUSTIVE SEARCH: Track all books for server-side search
            // Server search runs for ALL books to ensure no matches are missed
            const booksToSearch = [];
            
            setFilteredBooks(books.filter(book => {
                // EXHAUSTIVE SEARCH: Check ALL sources independently (no short-circuiting)
                // This ensures we find matches everywhere like AI query logic
                const matchSources = []; // Accumulate all match sources
                
                if (searchTerm && !naturalDateRange) {
                    // Only filter by text if NOT a pure date search
                    
                    // HASHTAG SEARCH: If query starts with #, search tags specifically
                    const isTagSearch = searchTerm.startsWith('#');
                    const tagQuery = isTagSearch ? searchTerm.slice(1).toLowerCase() : null;
                    
                    // SOURCE 1: Tag match (for hashtag searches)
                    if (isTagSearch && book.tags && Array.isArray(book.tags)) {
                        const matchesTag = book.tags.some(tag => 
                            tag.toLowerCase().includes(tagQuery)
                        );
                        if (matchesTag) matchSources.push('tag');
                    }
                    
                    // SOURCE 2: Book metadata (name, platform, status, etc.)
                    const bookMetadata = [
                        book.bridge_name || book.name || '',        // Book title
                        book.input_platform || '',                    // Input platform
                        book.output_platform || '',                   // Output platform
                        book.contact_info || '',                      // Contact info
                        book.status || '',                            // Status
                        book.created_at ? new Date(book.created_at).toLocaleString() : '', // Creation date
                        ...(book.tags || []).map(t => '#' + t)        // Tags (with # prefix)
                    ].join(' ').toLowerCase();
                    
                    if (window.searchState.performSearch(searchTerm, bookMetadata)) {
                        matchSources.push('metadata');
                    }
                    
                    // SOURCE 3: Cached messages (ALWAYS check, not just when metadata fails)
                    if (messageCache[book.fractal_id]) {
                        const messageText = getMessageSearchText(book.fractal_id);
                        if (window.searchState.performSearch(searchTerm, messageText)) {
                            matchSources.push('cache');
                        }
                    }
                    
                    // EXHAUSTIVE: Queue ALL books for server search (not just non-metadata matches)
                    // Server has full Discord history, cache may be incomplete
                    booksToSearch.push(book.fractal_id);
                    
                    // Store match sources for visual indicators
                    book._matchSources = matchSources;
                    book._matchType = matchSources.includes('cache') ? 'message' : 
                                      matchSources.includes('tag') ? 'tag' :
                                      matchSources.includes('metadata') ? 'metadata' : null;
                    
                    // SEAMLESS SEARCH: Store query for auto-filtering when book is opened
                    if (matchSources.length > 0) {
                        book._searchQuery = searchTerm;
                    }
                    
                    // Include book if ANY source matched
                    const matchesSearch = matchSources.length > 0;
                    const matchesPlatform = !platformFilter || book.input_platform === platformFilter;
                    return matchesSearch && matchesPlatform;
                }
                
                const matchesPlatform = !platformFilter || book.input_platform === platformFilter;
                return matchesPlatform;
            }));
            
            renderBooks();
            // Update thumbs zone if in mobile mode
            if (isMobile()) renderThumbsZone();
            
            // EXHAUSTIVE SERVER SEARCH: Search ALL books in Discord for complete results
            // This catches matches in paginated content not in cache
            if (searchTerm && booksToSearch.length > 0 && !naturalDateRange && !serverSearchPending && lastServerSearchTerm !== searchTerm) {
                serverSearchPending = true;
                lastServerSearchTerm = searchTerm;
                console.log(`🔍 Exhaustive server search for "${searchTerm}" in ${booksToSearch.length} books...`);
                
                try {
                    const response = await window.authFetch(`/api/search?term=${encodeURIComponent(searchTerm)}&bookIds=${booksToSearch.join(',')}`);
                    
                    if (response.ok) {
                        const data = await response.json();
                        const matchingBookIds = data.matchingBooks || [];
                        
                        if (matchingBookIds.length > 0) {
                            console.log(`✅ Server found matches in ${matchingBookIds.length} books:`, matchingBookIds);
                            
                            // Log if partial results due to rate limiting
                            if (data.partial) {
                                console.warn(`⚠️ Partial results: ${data.reason}`);
                            }
                            
                            // Track existing books in filtered list
                            const existingBooks = new Map(filteredBooks.map(b => [b.fractal_id, b]));
                            
                            for (const bookId of matchingBookIds) {
                                const existingBook = existingBooks.get(bookId);
                                
                                if (existingBook) {
                                    // MERGE: Add 'server' to existing book's match sources
                                    if (!existingBook._matchSources) existingBook._matchSources = [];
                                    if (!existingBook._matchSources.includes('server')) {
                                        existingBook._matchSources.push('server');
                                    }
                                    // Update match type if this is now a message match
                                    if (existingBook._matchType !== 'message') {
                                        existingBook._matchType = 'message';
                                    }
                                } else {
                                    // ADD: New book found by server search
                                    const originalBook = books.find(b => b.fractal_id === bookId);
                                    if (originalBook) {
                                        const bookCopy = { 
                                            ...originalBook, 
                                            _matchType: 'message', 
                                            _matchSources: ['server'],
                                            _searchQuery: searchTerm 
                                        };
                                        filteredBooks.push(bookCopy);
                                        existingBooks.set(bookId, bookCopy);
                                    }
                                }
                            }
                            
                            // Re-render with merged server results
                            renderBooks();
                            if (isMobile()) renderThumbsZone();
                        }
                    }
                } catch (err) {
                    console.warn('⚠️ Server search failed:', err);
                } finally {
                    // ALWAYS reset pending state, even on error
                    serverSearchPending = false;
                }
            }
            
            // Reset server search state if search term cleared
            if (!searchTerm) {
                lastServerSearchTerm = '';
                // Clear match indicators from all books
                books.forEach(b => {
                    delete b._matchType;
                    delete b._matchSources;
                    delete b._searchQuery;
                });
            }
        }

        function updatePlatformFilter() {
            const filter = document.getElementById('platformFilter');
            if (!filter) return; // Desktop-only feature, skip in mobile mode
            const platforms = [...new Set(books.map(book => book.input_platform))];
            
            const fragment = document.createDocumentFragment();
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'All Platforms';
            fragment.appendChild(defaultOption);
            
            platforms.forEach(p => {
                const option = document.createElement('option');
                option.value = p;
                option.textContent = p;
                fragment.appendChild(option);
            });
            
            filter.replaceChildren(fragment);
        }

        // QR-FIRST ARCHITECTURE: Open in-page modal (no popup window friction)
        let currentBookFractalId = null;
        let bookStatusPollInterval = null;
        
        function openCreatePopup() {
            // Reset modal state
            document.getElementById('book-form-section').style.display = 'block';
            document.getElementById('book-qr-section').style.display = 'none';
            document.getElementById('book-create-form').reset();
            currentBookFractalId = null;
            
            // Show modal
            document.getElementById('createBookModal').classList.add('active');
        }
        
        function closeCreateBookModal() {
            document.getElementById('createBookModal').classList.remove('active');
            if (bookStatusPollInterval) {
                clearInterval(bookStatusPollInterval);
                bookStatusPollInterval = null;
            }
            // Reload books to show any newly created books
            loadBooks();
        }
        
        function copyBookFractalId() {
            if (currentBookFractalId) {
                navigator.clipboard.writeText(currentBookFractalId).then(() => {
                    const btn = event.target;
                    const originalText = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    btn.style.background = 'rgba(34, 197, 94, 0.2)';
                    btn.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                    btn.style.color = '#22c55e';
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.style.background = 'rgba(167, 139, 250, 0.2)';
                        btn.style.borderColor = 'rgba(167, 139, 250, 0.3)';
                        btn.style.color = '#a78bfa';
                    }, 1500);
                }).catch(err => {
                    alert('Failed to copy: ' + err.message);
                });
            }
        }
        
        let _channelConfig = null;

        async function loadChannelConfig() {
            if (_channelConfig) return _channelConfig;
            try {
                const res = await window.authFetch('/api/books/channel-config');
                if (res.ok) {
                    _channelConfig = await res.json();
                    const lineOpt = document.getElementById('line-platform-option');
                    if (lineOpt && _channelConfig.lineOaId) {
                        lineOpt.style.display = '';
                    }
                    const tgOpt = document.getElementById('telegram-platform-option');
                    if (tgOpt && _channelConfig.telegramConfigured) {
                        tgOpt.style.display = '';
                    }
                }
            } catch (e) {
                console.warn('⚠️ Could not load channel config:', e.message);
            }
            return _channelConfig;
        }

        function showBookActivationModal(fractalId, platform) {
            const book = books.find(b => b.fractal_id === fractalId);
            if (!book) {
                console.error('Book not found:', fractalId);
                showToast('❌ Book not found', 'error');
                return;
            }

            const waSteps       = document.getElementById('wa-activation-steps');
            const lineSteps     = document.getElementById('line-activation-steps');
            const telegramSteps = document.getElementById('telegram-activation-steps');
            const subtitle      = document.getElementById('book-activation-subtitle');

            const resolvedPlatform = platform || book.input_platform || 'whatsapp';

            // Hide all step sections first
            if (waSteps)       waSteps.style.display = 'none';
            if (lineSteps)     lineSteps.style.display = 'none';
            if (telegramSteps) telegramSteps.style.display = 'none';

            if (resolvedPlatform === 'telegram') {
                const joinCode = (book.contact_info || '').trim();
                if (!joinCode) {
                    showToast('❌ No activation code found', 'error');
                    return;
                }
                const botUsername = _channelConfig?.telegramBotUsername || '';
                // If we have the bot username, build a deep link with /start pre-filled
                const botLink = botUsername
                    ? `https://t.me/${botUsername}?start=${encodeURIComponent(joinCode)}`
                    : `https://t.me/`;  // fallback: open Telegram (no pre-fill without username)

                document.getElementById('telegram-join-code').textContent = joinCode;
                document.getElementById('telegram-bot-link').href = botLink;

                const copyTgBtn = document.getElementById('copy-telegram-code-btn');
                if (copyTgBtn) {
                    copyTgBtn.onclick = () => {
                        navigator.clipboard.writeText(joinCode).then(() => {
                            copyTgBtn.textContent = '✅';
                            setTimeout(() => { copyTgBtn.textContent = 'Copy'; }, 1500);
                        });
                    };
                }

                if (subtitle) subtitle.textContent = 'Open bot → send code to activate';
                if (telegramSteps) telegramSteps.style.display = 'block';
                console.log('✈️ Showing Telegram activation for:', book.name, 'Code:', joinCode);
            } else if (resolvedPlatform === 'line') {
                const joinCode = (book.contact_info || '').trim();
                if (!joinCode) {
                    showToast('❌ No activation code found', 'error');
                    return;
                }
                const lineOaId = _channelConfig?.lineOaId || '';
                const addFriendUrl = `https://line.me/R/ti/p/@${lineOaId}`;
                const sendCodeUrl = `https://line.me/R/oaMessage/@${lineOaId}?text=${encodeURIComponent(joinCode)}`;

                document.getElementById('line-join-code').textContent = joinCode;
                document.getElementById('line-add-friend-link').href = addFriendUrl;
                document.getElementById('line-send-code-link').href = sendCodeUrl;
                document.getElementById('line-qr-img').src =
                    `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(addFriendUrl)}`;

                if (subtitle) subtitle.textContent = 'Add friend → send code to activate';
                if (lineSteps) lineSteps.style.display = 'block';
                console.log('🟢 Showing LINE activation for:', book.name, 'Code:', joinCode);
            } else {
                const joinCode = (book.contact_info || '').replace(/^join baby-ability\s+/i, '').trim();
                if (!joinCode) {
                    showToast('❌ No activation code found', 'error');
                    return;
                }
                document.getElementById('book-join-code').textContent = joinCode;

                if (subtitle) subtitle.textContent = 'Follow 2 steps to activate WhatsApp';
                if (waSteps) waSteps.style.display = 'block';
                console.log('📱 Showing WhatsApp activation for:', book.name, 'Code:', joinCode);
            }

            document.getElementById('book-name-display').textContent = `📖 ${book.name}`;
            document.getElementById('book-fractal-id').textContent = book.fractal_id;

            document.getElementById('book-form-section').style.display = 'none';
            document.getElementById('book-qr-section').style.display = 'block';
            document.getElementById('createBookModal').classList.add('active');
        }

        function showWhatsAppActivationModal(fractalId) {
            showBookActivationModal(fractalId, 'whatsapp');
        }
        
        // Handle book creation form submission
        document.addEventListener('DOMContentLoaded', function() {
            // Initialize URL hash support for shareable message links
            initUrlHashSupport();
            
            // Load channel config to enable/disable platform options
            loadChannelConfig();
            
            const bookForm = document.getElementById('book-create-form');
            if (bookForm) {
                bookForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    
                    const bookName = document.getElementById('book-name-input').value;
                    const platform = document.getElementById('book-platform-input').value;
                    
                    // CLIENT-SIDE VALIDATION: Block empty/whitespace book names
                    const trimmedName = bookName?.trim();
                    if (!trimmedName) {
                        showToast('❌ Book name cannot be empty', 'error');
                        document.getElementById('book-name-input').focus();
                        return;
                    }
                    
                    if (trimmedName.length < 2) {
                        showToast('❌ Book name must be at least 2 characters', 'error');
                        document.getElementById('book-name-input').focus();
                        return;
                    }
                    
                    const submitBtn = bookForm.querySelector('button[type="submit"]');
                    const originalText = submitBtn.textContent;
                    submitBtn.disabled = true;
                    submitBtn.replaceChildren();
                    const loadingSpan = document.createElement('span');
                    loadingSpan.className = 'book-loading';
                    submitBtn.appendChild(loadingSpan);
                    submitBtn.appendChild(document.createTextNode(' Creating book...'));
                    
                    try {
                        // 1. CREATE BOOK (webhook optional - add later in Edit tab)
                        // Uses unified window.authFetch for automatic token refresh
                        console.log('📝 Creating book:', bookName);
                        const createRes = await window.authFetch('/api/books', {
                            method: 'POST',
                            body: JSON.stringify({
                                name: bookName,
                                inputPlatform: platform
                            })
                        });
                        
                        if (!createRes.ok) {
                            // Try to parse error as JSON, fallback to text
                            let errorMessage = 'Failed to create book';
                            try {
                                const error = await createRes.json();
                                errorMessage = error.error || errorMessage;
                            } catch {
                                // If JSON parsing fails, get text (might be HTML error page)
                                const text = await createRes.text();
                                console.error('Non-JSON error response:', text.substring(0, 200));
                                errorMessage = 'Server error - please try logging in again';
                            }
                            throw new Error(errorMessage);
                        }
                        
                        const book = await createRes.json();
                        console.log('✅ Book created:', book);
                        
                        if (!book.fractal_id) {
                            throw new Error('No fractal_id returned from server');
                        }
                        
                        // Store fractal_id globally and in localStorage for recovery
                        currentBookFractalId = book.fractal_id;
                        const recentBooks = JSON.parse(localStorage.getItem('recentBooks') || '[]');
                        recentBooks.unshift({
                            fractal_id: book.fractal_id,
                            name: bookName,
                            created_at: new Date().toISOString()
                        });
                        localStorage.setItem('recentBooks', JSON.stringify(recentBooks.slice(0, 10)));
                        
                        // Reset submit button
                        submitBtn.disabled = false;
                        submitBtn.textContent = originalText;
                        
                        // Close create modal
                        closeCreateBookModal();
                        
                        // Reload books to show the new one
                        await loadBooks();
                        
                        // Show channel-appropriate activation modal
                        if (book.contact_info) {
                            showBookActivationModal(book.fractal_id, platform);
                            showToast('✅ Book created! Follow the 2 steps to activate.', 'success');
                        }
                        
                    } catch (err) {
                        console.error('❌ Error:', err);
                        alert('Error: ' + err.message);
                        submitBtn.disabled = false;
                        submitBtn.textContent = originalText;
                    }
                });
            }
        });
        
        // LEGACY: Keep for backward compatibility
        function openCreateBotModal() {
            // Show quick-start wizard for new users
            if (books.length === 0 || !localStorage.getItem('skipQuickStart')) {
                openQuickStartWizard();
                return;
            }
            
            setEditingBookId(null);
            document.getElementById('modalTitle').textContent = 'Create New Book';
            document.getElementById('botForm').reset();
            setBotTags([]);
            setBotWebhooks([]);
            renderTags();
            renderWebhooks();
            document.getElementById('botModal').classList.add('active');
        }

        function editBook(fractalId) {
            // Find book by fractal_id (hash string like "dev_bridge_t9_54ab7617ffeb")
            const book = books.find(b => b.fractal_id === fractalId);
            if (!book) {
                console.error('Book not found:', fractalId, 'Available books:', books.map(b => b.fractal_id));
                return;
            }
            
            setEditingBookId(fractalId);
            document.getElementById('modalTitle').textContent = 'Edit Book';
            document.getElementById('botName').value = book.name || '';
            setBotTags(book.tags || []);

            // Show book code (read-only, edit mode only)
            const bookCodeSection = document.getElementById('bookCodeSection');
            const bookCodeDisplay = document.getElementById('bookCodeDisplay');
            if (bookCodeSection && bookCodeDisplay) {
                bookCodeDisplay.value = book.fractal_id || '';
                bookCodeSection.style.display = 'block';
            }
            
            // Load webhooks from output_01_url and output_0n_url
            setBotWebhooks([]);
            if (book.output_0n_url) {
                botWebhooks.push({
                    id: Date.now(),
                    name: 'User Discord',
                    url: book.output_0n_url
                });
            }
            
            renderTags();
            renderWebhooks();

            // Show outpipes section when editing
            const outpipesSection = document.getElementById('outpipesSection');
            if (outpipesSection) {
                outpipesSection.style.display = 'block';
                userOutpipes = Array.isArray(book.outpipes_user) && book.outpipes_user.length > 0
                    ? book.outpipes_user.map((p, i) => ({ ...p, _idx: i }))
                    : [];
                renderOutpipes();
            }
            
            // Show share section when editing
            const shareSection = document.getElementById('shareBookSection');
            if (shareSection) {
                shareSection.style.display = 'block';
                loadBookShares(fractalId);
            }

            const agentTokenSection = document.getElementById('agentTokenSection');
            if (agentTokenSection) {
                agentTokenSection.style.display = 'block';
                loadAgentTokenStatus(fractalId);
            }
            
            document.getElementById('botModal').classList.add('active');
        }
        
        // Book sharing functions - delegate to BooksModule
        async function loadBookShares(fractalId) {
            const container = document.getElementById('sharedEmailsList');
            if (!container) return;
            
            container.innerHTML = '<span style="color: #94a3b8; font-size: 0.75rem;">Loading...</span>';
            
            const result = await _B.loadBookShares(fractalId);
            if (result.success) {
                renderSharedEmails(result.shares, fractalId);
            } else {
                container.innerHTML = '<span style="color: #ef4444; font-size: 0.75rem;">Failed to load shares</span>';
            }
        }
        
        function renderSharedEmails(shares, fractalId) {
            const container = document.getElementById('sharedEmailsList');
            if (!container) return;
            
            if (shares.length === 0) {
                container.innerHTML = '<span style="color: #64748b; font-size: 0.75rem;">No shares yet</span>';
                return;
            }
            
            container.innerHTML = '';
            shares.forEach(share => {
                const chip = document.createElement('div');
                chip.style.cssText = 'display: inline-flex; align-items: center; gap: 0.5rem; background: rgba(124, 58, 237, 0.1); border: 1px solid rgba(124, 58, 237, 0.2); border-radius: 9999px; padding: 0.25rem 0.5rem 0.25rem 0.75rem; font-size: 0.75rem; color: #a78bfa;';
                
                const emailSpan = document.createElement('span');
                emailSpan.textContent = share.shared_with_email;
                chip.appendChild(emailSpan);
                
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.textContent = '×';
                removeBtn.style.cssText = 'background: rgba(239, 68, 68, 0.2); border: none; color: #ef4444; width: 18px; height: 18px; border-radius: 50%; cursor: pointer; font-size: 0.875rem; line-height: 1; display: flex; align-items: center; justify-content: center;';
                removeBtn.onclick = () => revokeBookShare(fractalId, share.shared_with_email);
                chip.appendChild(removeBtn);
                
                container.appendChild(chip);
            });
        }
        
        async function shareBook(fractalId, email) {
            const result = await _B.shareBook(fractalId, email);
            if (!result.success) {
                showToast(result.error || 'Failed to share', 'error');
                return;
            }
            
            if (result.alreadyShared) {
                showToast('Already shared with this email', 'info');
            } else {
                showToast(`Invited ${email} to view this book`, 'success');
            }
            
            document.getElementById('shareEmailInput').value = '';
            loadBookShares(fractalId);
        }
        
        function revokeBookShare(fractalId, email) {
            nyanConfirm(`Revoke access for ${email}?`, null, async () => {
                const result = await _B.revokeBookShare(fractalId, email);
                if (!result.success) {
                    showToast(result.error || 'Failed to revoke', 'error');
                    return;
                }
                showToast(`Revoked access for ${email}`, 'success');
                loadBookShares(fractalId);
            });
        }

        function _agentEndpointUrl(fractalId) {
            return window.location.origin + '/api/webhook/' + fractalId + '/messages';
        }

        function _renderAgentEndpointBlock(fractalId) {
            const url = _agentEndpointUrl(fractalId);
            const el = document.createElement('div');
            el.style.cssText = 'background: rgba(15,23,42,0.6); border: 1px solid rgba(100,116,139,0.25); border-radius: 6px; padding: 0.5rem; font-family: monospace; font-size: 0.7rem; color: #94a3b8; word-break: break-all; margin-bottom: 0.25rem;';
            el.textContent = url;
            return el;
        }

        function _renderAgentActions(fractalId, actions, clear) {
            if (clear !== false) actions.innerHTML = '';
            const rotateBtn = document.createElement('button');
            rotateBtn.type = 'button';
            rotateBtn.textContent = 'Rotate';
            rotateBtn.style.cssText = 'background: rgba(251,191,36,0.15); border: 1px solid rgba(251,191,36,0.3); color: #fbbf24; border-radius: 6px; padding: 0.35rem 0.75rem; cursor: pointer; font-size: 0.8rem;';
            rotateBtn.onclick = () => nyanConfirm('Rotate HTTP token?', 'The old token will stop working immediately. Any agent or node using it must be updated.', () => generateAgentToken(fractalId), true, 'Rotate');
            const revokeBtn = document.createElement('button');
            revokeBtn.type = 'button';
            revokeBtn.textContent = 'Revoke';
            revokeBtn.style.cssText = 'background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; border-radius: 6px; padding: 0.35rem 0.75rem; cursor: pointer; font-size: 0.8rem;';
            revokeBtn.onclick = () => nyanConfirm('Revoke HTTP token?', 'Your agents and nodes will lose access to this book immediately.', () => revokeAgentToken(fractalId), true, 'Revoke');
            actions.appendChild(rotateBtn);
            actions.appendChild(revokeBtn);
        }

        async function loadAgentTokenStatus(fractalId) {
            const display = document.getElementById('agentTokenDisplay');
            const actions = document.getElementById('agentTokenActions');
            if (!display || !actions) return;
            display.innerHTML = '<span style="color: #94a3b8; font-size: 0.75rem;">Checking...</span>';
            actions.innerHTML = '';
            try {
                const res = await fetch(`/api/books/${fractalId}/agent-token`, { credentials: 'include' });
                const data = await res.json();
                if (data.has_token) {
                    display.innerHTML = '';
                    display.appendChild(_renderAgentEndpointBlock(fractalId));
                    const status = document.createElement('span');
                    status.style.cssText = 'color: #10b981; font-size: 0.8rem;';
                    status.innerHTML = '&#x2713; Connected';
                    display.appendChild(status);
                    _renderAgentActions(fractalId, actions);
                } else {
                    display.innerHTML = '';
                    const genBtn = document.createElement('button');
                    genBtn.type = 'button';
                    genBtn.textContent = 'Generate Token';
                    genBtn.style.cssText = 'background: rgba(59,130,246,0.15); border: 1px solid rgba(59,130,246,0.3); color: #60a5fa; border-radius: 6px; padding: 0.35rem 0.75rem; cursor: pointer; font-size: 0.8rem;';
                    genBtn.onclick = () => nyanConfirm('Generate HTTP token?', 'This creates a one-time token that lets your agent or node access this book\'s message stream.', () => generateAgentToken(fractalId), false, 'Generate');
                    actions.appendChild(genBtn);
                }
            } catch (err) {
                display.innerHTML = '<span style="color: #ef4444; font-size: 0.75rem;">Failed to check token status</span>';
            }
        }

        async function generateAgentToken(fractalId) {
            try {
                const res = await fetch(`/api/books/${fractalId}/agent-token`, { method: 'POST', credentials: 'include' });
                const data = await res.json();
                if (!data.success) { showToast(data.error || 'Failed to generate token', 'error'); return; }
                const display = document.getElementById('agentTokenDisplay');
                const actions = document.getElementById('agentTokenActions');
                const url = _agentEndpointUrl(fractalId);
                const copyPayload = 'Endpoint: ' + url + '\nAuthorization: Bearer ' + data.token;
                if (display) {
                    display.innerHTML = '';
                    const block = document.createElement('div');
                    block.style.cssText = 'background: rgba(15,23,42,0.6); border: 1px solid rgba(59,130,246,0.3); border-radius: 6px; padding: 0.5rem; font-family: monospace; font-size: 0.7rem; color: #60a5fa; word-break: break-all; white-space: pre-wrap; margin-bottom: 0.25rem;';
                    block.textContent = copyPayload;
                    display.appendChild(block);
                    const warn = document.createElement('small');
                    warn.style.cssText = 'color: #fbbf24; font-size: 0.7rem;';
                    warn.textContent = 'Copy this now \u2014 the token will not be shown again.';
                    display.appendChild(warn);
                }
                if (actions) {
                    actions.innerHTML = '';
                    const copyBtn = document.createElement('button');
                    copyBtn.type = 'button';
                    copyBtn.textContent = 'Copy All';
                    copyBtn.style.cssText = 'background: rgba(59,130,246,0.15); border: 1px solid rgba(59,130,246,0.3); color: #60a5fa; border-radius: 6px; padding: 0.35rem 0.75rem; cursor: pointer; font-size: 0.8rem;';
                    copyBtn.onclick = () => { navigator.clipboard.writeText(copyPayload).then(() => showToast('Copied to clipboard', 'success')).catch(() => showToast('Copy failed — select and copy manually', 'error')); };
                    actions.appendChild(copyBtn);
                    _renderAgentActions(fractalId, actions, false);
                }
                showToast('Agent token generated', 'success');
            } catch (err) {
                showToast('Failed to generate token', 'error');
            }
        }

        async function revokeAgentToken(fractalId) {
            try {
                const res = await fetch(`/api/books/${fractalId}/agent-token`, { method: 'DELETE', credentials: 'include' });
                const data = await res.json();
                if (!data.success) { showToast(data.error || 'Failed to revoke', 'error'); return; }
                showToast('Agent token revoked', 'success');
                loadAgentTokenStatus(fractalId);
            } catch (err) {
                showToast('Failed to revoke token', 'error');
            }
        }

        function closeBotModal() {
            document.getElementById('botModal').classList.remove('active');
            document.getElementById('botName').value = '';
            setEditingBookId(null);
            setBotTags([]);
            setBotWebhooks([]);
            userOutpipes = [];

            // Hide outpipes section and clear
            const outpipesSection = document.getElementById('outpipesSection');
            if (outpipesSection) outpipesSection.style.display = 'none';
            const outpipesList = document.getElementById('outpipesList');
            if (outpipesList) outpipesList.replaceChildren();
            
            // Hide book code section
            const bookCodeSection = document.getElementById('bookCodeSection');
            if (bookCodeSection) bookCodeSection.style.display = 'none';

            // Hide share section and clear
            const shareSection = document.getElementById('shareBookSection');
            if (shareSection) {
                shareSection.style.display = 'none';
            }
            const agentTokenSection = document.getElementById('agentTokenSection');
            if (agentTokenSection) agentTokenSection.style.display = 'none';
            const agentTokenDisplay = document.getElementById('agentTokenDisplay');
            if (agentTokenDisplay) agentTokenDisplay.innerHTML = '';
            const agentTokenActions = document.getElementById('agentTokenActions');
            if (agentTokenActions) agentTokenActions.innerHTML = '';
            const shareInput = document.getElementById('shareEmailInput');
            if (shareInput) shareInput.value = '';
            const sharedList = document.getElementById('sharedEmailsList');
            if (sharedList) sharedList.innerHTML = '';
        }

        // Quick Start Wizard Functions
        function openQuickStartWizard() {
            document.getElementById('quickStartWizard').classList.add('active');
        }

        function closeQuickStartWizard() {
            document.getElementById('quickStartWizard').classList.remove('active');
        }

        function skipQuickStart() {
            localStorage.setItem('skipQuickStart', 'true');
            closeQuickStartWizard();
            // Open regular create modal
            setEditingBookId(null);
            document.getElementById('modalTitle').textContent = 'Create New Book';
            document.getElementById('botForm').reset();
            setBotTags([]);
            setBotWebhooks([]);
            renderTags();
            renderWebhooks();
            document.getElementById('botModal').classList.add('active');
        }

        function startBookSetup() {
            closeQuickStartWizard();
            // Open regular create modal with a hint banner
            setEditingBookId(null);
            document.getElementById('modalTitle').textContent = 'Create New Book';
            document.getElementById('botForm').reset();
            setBotTags([]);
            setBotWebhooks([]);
            renderTags();
            renderWebhooks();
            document.getElementById('botModal').classList.add('active');
            
            // Show helpful banner at top of form
            const form = document.getElementById('botForm');
            const existingBanner = form.querySelector('.setup-banner');
            if (existingBanner) existingBanner.remove();
            
            const banner = document.createElement('div');
            banner.className = 'setup-banner';
            banner.style.cssText = 'background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 1rem; border-radius: 0.5rem; margin-bottom: 1rem; font-size: 0.875rem;';
            const strong1 = document.createElement('strong');
            strong1.textContent = '🎯 Step 1:';
            const strong2 = document.createElement('strong');
            strong2.textContent = 'Step 2:';
            const strong3 = document.createElement('strong');
            strong3.textContent = 'Done!';
            banner.appendChild(strong1);
            banner.appendChild(document.createTextNode(' Fill in book name → '));
            banner.appendChild(strong2);
            banner.appendChild(document.createTextNode(' Send join code via WhatsApp → '));
            banner.appendChild(strong3);
            banner.appendChild(document.createTextNode(' Add webhook later in Edit'));
            form.insertBefore(banner, form.firstChild);
        }

        async function saveBotClicked(event) {
            event.preventDefault();
            
            const bookName = document.getElementById('botName').value;

            // Filter out empty webhooks
            const validWebhooks = botWebhooks.filter(w => w.url && w.url.trim());
            
            // SECURITY: Check if webhook URL is changing (requires password ONLY when editing)
            let password = null;
            
            if (editingBookId) {
                // Only for EDIT operations - not for new book creation
                const existingBook = books.find(b => b.fractal_id === editingBookId);
                const existingWebhookUrl = existingBook?.output_0n_url;
                const newWebhookUrl = validWebhooks[0]?.url;
                
                // If webhook URL is changing, require password
                if (newWebhookUrl && newWebhookUrl !== existingWebhookUrl) {
                    password = await showPasswordModal('You are changing the webhook URL. Enter your account password to confirm this security-sensitive change.');
                    
                    if (!password) {
                        showToast('Webhook URL change cancelled — password is required.', 'error');
                        return;
                    }
                }
            }
            // No password required for new book creation (genesis)
            
            // Preserve existing output_credentials structure when editing (keeps Ledger thread)
            let outputCredentials;
            if (editingBookId) {
                // Find the existing book to preserve its Ledger thread (output_01)
                const existingBook = books.find(b => b.fractal_id === editingBookId);
                if (existingBook && existingBook.output_credentials) {
                    // Preserve existing structure, only update user webhooks
                    outputCredentials = {
                        ...existingBook.output_credentials,
                        webhooks: validWebhooks.map(w => ({ name: w.name, url: w.url }))
                    };
                } else {
                    outputCredentials = {
                        webhooks: validWebhooks.map(w => ({ name: w.name, url: w.url }))
                    };
                }
            } else {
                // New book: just webhooks
                outputCredentials = {
                    webhooks: validWebhooks.map(w => ({ name: w.name, url: w.url }))
                };
                
            }
            
            const botData = {
                name: bookName || 'New Book',
                inputCredentials: {},
                outputCredentials: outputCredentials,
                tags: botTags,
                status: 'active'
            };
            
            // Add userOutputUrl from first webhook (for output_0n_url column)
            // This ensures webhooks are properly saved when editing books
            if (validWebhooks.length > 0) {
                botData.userOutputUrl = validWebhooks[0].url;
            } else if (editingBookId) {
                // When editing and no webhooks provided, explicitly set to null to clear
                botData.userOutputUrl = null;
            }
            // For new books without webhooks, don't send userOutputUrl (undefined = optional)
            
            // Add password if webhook is changing
            if (password) {
                botData.password = password;
            }

            try {
                const url = editingBookId ? `/api/books/${editingBookId}` : '/api/books';
                const method = editingBookId ? 'PUT' : 'POST';
                
                const response = await window.authFetch(url, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(botData)
                });

                if (response.ok) {
                    const updatedBook = await response.json();
                    closeBotModal();
                    
                    if (editingBookId) {
                        // OPTIMIZATION: For edits, update local state without full refresh
                        // This prevents unnecessary book reinitiation and screen flicker
                        const index = books.findIndex(b => b.fractal_id === editingBookId);
                        if (index !== -1) {
                            books[index] = updatedBook;
                            setFilteredBooks(books);
                            renderBooks(true); // Skip detail re-render to preserve state
                        }
                        showToast('Book updated successfully.', 'success');
                    } else {
                        // For new books, do full refresh to initialize WhatsApp client
                        loadBooks();
                        showToast('Book created! Click ▶️ to start WhatsApp.', 'success');
                    }
                } else {
                    const errorData = await response.json().catch(() => ({}));
                    
                    // Handle password errors specifically
                    if (errorData.invalidPassword) {
                        showToast('Wrong password — webhook URL was not changed. All other changes were saved.', 'error');
                    } else if (errorData.requiresPassword) {
                        showToast('Password required to change webhook URL.', 'error');
                    } else {
                        showToast(errorData.error || 'Failed to save book.', 'error');
                    }
                }
            } catch (error) {
                console.error('Error saving bot:', error);
                showToast(error.message || 'Error saving book.', 'error');
            }
        }


        function relinkWhatsApp(bookId) {
            nyanConfirm('Show WhatsApp activation instructions?', 'Your user will need to text the join code to the Twilio number and send their book code.', async () => {
                const result = await _B.relinkWhatsApp(bookId);
                if (result.success) {
                    showWhatsAppActivationModal(bookId);
                } else {
                    alert(`Failed to relink WhatsApp: ${result.error || 'Unknown error'}`);
                }
            }, false, 'Show');
        }

        function _escHtml(s) {
            const d = document.createElement('div');
            d.textContent = s;
            return d.innerHTML;
        }

        function nyanConfirm(message, subtext, onConfirm, danger = true, okLabel = 'Confirm') {
            const existing = document.getElementById('nyanConfirmOverlay');
            if (existing) existing.remove();
            const overlay = document.createElement('div');
            overlay.id = 'nyanConfirmOverlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
            const color = danger ? '#ef4444' : '#a855f7';
            const colorBg = danger ? 'rgba(239,68,68,0.15)' : 'rgba(168,85,247,0.15)';
            overlay.innerHTML = `
              <div style="background:rgba(15,23,42,0.95);border:1px solid rgba(148,163,184,0.25);border-radius:16px;padding:1.75rem 2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
                <div style="font-size:1rem;font-weight:600;color:#e2e8f0;margin-bottom:0.5rem;">${_escHtml(message)}</div>
                ${subtext ? `<div style="font-size:0.8rem;color:#94a3b8;margin-bottom:1.25rem;">${_escHtml(subtext)}</div>` : '<div style="margin-bottom:1.25rem;"></div>'}
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                  <button id="nyanConfirmCancel" style="padding:0.5rem 1.25rem;background:rgba(148,163,184,0.15);border:1px solid rgba(148,163,184,0.3);border-radius:8px;color:#94a3b8;cursor:pointer;font-size:0.875rem;">Cancel</button>
                  <button id="nyanConfirmOk" style="padding:0.5rem 1.25rem;background:${colorBg};border:1px solid ${color}55;border-radius:8px;color:${color};cursor:pointer;font-size:0.875rem;font-weight:600;">${_escHtml(okLabel)}</button>
                </div>
              </div>`;
            document.body.appendChild(overlay);
            const close = () => overlay.remove();
            overlay.querySelector('#nyanConfirmCancel').onclick = close;
            overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
            overlay.querySelector('#nyanConfirmOk').onclick = () => { close(); onConfirm(); };
        }

        async function confirmDeleteBook(fractalId) {
            // Find book by fractal_id (hash string)
            const book = books.find(b => b.fractal_id === fractalId);
            if (!book) {
                console.error(`Book ${fractalId} not found in books array`);
                return;
            }
            const bookLabel = book.name || (book.input_platform + ' → ' + book.output_platform);
            nyanConfirm(
                `Delete "${bookLabel}"?`,
                'All messages will be preserved in Discord.',
                () => _executeDeleteBook(fractalId)
            );
        }

        async function _executeDeleteBook(fractalId) {
            
            // Prevent double-clicks during deletion
            const deleteBtn = document.querySelector(`[data-delete-book="${fractalId}"]`);
            if (deleteBtn) deleteBtn.disabled = true;
            
            try {
                console.log('🗑️ DELETE request for book:', fractalId);
                const response = await window.authFetch(`/api/books/${fractalId}`, {
                    method: 'DELETE'
                });
                
                console.log('🗑️ DELETE response status:', response.status, response.ok);
                
                if (response.ok) {
                    // Immediately remove from arrays to sync state
                    setBooks(books.filter(b => b.fractal_id !== fractalId));
                    setFilteredBooks(filteredBooks.filter(b => b.fractal_id !== fractalId));
                    
                    // Animate book card deletion with liquid glass effect
                    const bookCard = document.querySelector(`.book-list-item[data-fractal-id="${fractalId}"]`);
                    if (bookCard) {
                        console.log('🗑️ Card found, animating...');
                        // Apply liquid glass delete animation
                        bookCard.style.transition = 'all 0.6s cubic-bezier(0.4, 0.0, 0.2, 1)';
                        bookCard.style.transform = 'scale(0.95)';
                        bookCard.style.opacity = '0.7';
                        bookCard.style.filter = 'blur(4px)';
                        
                        // Second phase: shrink and fade out with glass effect
                        setTimeout(() => {
                            bookCard.style.transform = 'scale(0.85) translateX(-30px)';
                            bookCard.style.opacity = '0';
                            bookCard.style.filter = 'blur(15px)';
                            bookCard.style.maxHeight = '0';
                            bookCard.style.marginBottom = '0';
                            bookCard.style.paddingTop = '0';
                            bookCard.style.paddingBottom = '0';
                            bookCard.style.overflow = 'hidden';
                        }, 150);
                        
                        // Remove from DOM after animation
                        setTimeout(() => {
                            bookCard.remove();
                            
                            // Clear selection and detail view if deleted book was selected
                            if (selectedBookId === fractalId) {
                                setSelectedBookId(null);
                                const detail = document.getElementById('bookDetail');
                                if (detail) {
                                    const p = document.createElement('p');
                                    p.style.cssText = 'text-align: center; color: #94a3b8; padding: 2rem;';
                                    p.textContent = 'Select a book to view messages';
                                    detail.replaceChildren(p);
                                }
                            }
                            
                            // Update book count in Books tab
                            updateBookCount();
                            
                            // Show success toast
                            showToast('✅ Book deleted successfully', 'success');
                            
                            // If no books left, show empty state
                            if (books.length === 0) {
                                const sidebar = document.getElementById('bookListContainer');
                                if (sidebar) {
                                    const p = document.createElement('p');
                                    p.style.cssText = 'text-align: center; color: #94a3b8; padding: 2rem; font-size: 0.875rem;';
                                    p.textContent = 'No books found';
                                    sidebar.replaceChildren(p);
                                }
                            }
                            
                            // Trigger full render to ensure consistency
                            renderBooks();
                        }, 750);
                    } else {
                        console.log('🗑️ Card not found, full refresh...');
                        // Fallback: full refresh if card not found
                        setSelectedBookId(null);
                        showToast('✅ Book deleted successfully', 'success');
                        renderBooks();
                    }
                } else {
                    const error = await response.json();
                    console.error('🗑️ DELETE failed:', error);
                    // Re-enable button on error
                    if (deleteBtn) deleteBtn.disabled = false;
                    
                    // Provide contextualized error messages for dashboard book management
                    let errorMsg = '❌ Could not delete book';
                    if (error.error?.includes('not found')) {
                        errorMsg = '⚠️ Book appears to have been deleted or moved. Try refreshing your books list.';
                    } else if (response.status === 500) {
                        errorMsg = '❌ Server error during deletion. Please try again or contact support.';
                    } else if (response.status === 403) {
                        errorMsg = '❌ You don\'t have permission to delete this book.';
                    }
                    showToast(errorMsg, 'error');
                }
            } catch (error) {
                console.error('🗑️ Error deleting book:', error);
                if (deleteBtn) deleteBtn.disabled = false;
                showToast('❌ Network error while deleting. Check your connection and try again.', 'error');
            }
        }
        
        // Download book data (messages + drops) as ZIP
        async function downloadBookData(fractalId) {
            try {
                const book = books.find(b => b.fractal_id === fractalId);
                if (!book) {
                    showToast('❌ Book not found', 'error');
                    return;
                }
                
                // Get selected message IDs for this book
                const selectedIds = selectedMessages[fractalId] 
                    ? Array.from(selectedMessages[fractalId]) 
                    : [];
                
                console.log('📦 EXPORT FLOW START');
                console.log('📦 Book ID:', fractalId);
                console.log('📦 Book Name:', book.name);
                console.log('📦 Selected IDs:', selectedIds);
                console.log('📦 Selected Count:', selectedIds.length);
                
                if (selectedIds.length === 0) {
                    showToast('❌ Please select messages to export', 'error');
                    return;
                }
                
                showToast(`📦 Preparing export of ${selectedIds.length} message(s)...`, 'info');
                
                console.log('📦 Sending POST request to /api/books/' + fractalId + '/export');
                console.log('📦 Payload:', { messageIds: selectedIds });
                
                // Send selected message IDs to backend
                const response = await window.authFetch(`/api/books/${fractalId}/export`, {
                    method: 'POST',
                    body: JSON.stringify({ messageIds: selectedIds })
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    showToast(`❌ Export failed: ${error.error || 'Unknown error'}`, 'error');
                    return;
                }
                
                // Get the blob and create download link
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = `${(book.name || 'book').replace(/[^a-z0-9]/gi, '_')}_export.zip`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                
                showToast('✅ Export downloaded successfully!', 'success');
                
            } catch (error) {
                console.error('Error exporting book data:', error);
                showToast('❌ Export failed', 'error');
            }
        }
        
        // Restore checkbox checked states after rendering
        function restoreCheckboxStates(bookId) {
            if (!selectedMessages[bookId]) return;
            
            selectedMessages[bookId].forEach(msgId => {
                const checkbox = document.querySelector(`input.message-export-checkbox[data-message-id="${msgId}"]`);
                if (checkbox) {
                    checkbox.checked = true;
                }
            });
        }
        
        // Update bulk action buttons (Download & Tag) state based on selected messages
        function updateBulkActionButtons(bookId) {
            console.log(`🔄 updateBulkActionButtons called for book: ${bookId}`);
            const downloadBtn = document.querySelector(`[data-download-book="${bookId}"]`);
            const tagBtn = document.querySelector(`[data-tag-book="${bookId}"]`);
            
            if (!downloadBtn || !tagBtn) {
                console.warn(`⚠️ Bulk action buttons not found for book: ${bookId}`);
                return;
            }
            
            const count = selectedMessages[bookId] ? selectedMessages[bookId].size : 0;
            console.log(`📊 Selected count for ${bookId}: ${count}`);
            
            if (count > 0) {
                // Enable Download button
                downloadBtn.textContent = `⬇️ Attachment (${count})`;
                downloadBtn.disabled = false;
                downloadBtn.style.opacity = '1';
                
                // Enable Tag button
                tagBtn.textContent = `🏷️ Tag (${count})`;
                tagBtn.disabled = false;
                tagBtn.style.opacity = '1';
                
                console.log(`✅ Bulk action buttons enabled with ${count} messages`);
            } else {
                // Disable Download button
                downloadBtn.textContent = '⬇️ Attachment';
                downloadBtn.disabled = true;
                downloadBtn.style.opacity = '0.5';
                
                // Disable Tag button
                tagBtn.textContent = '🏷️ Tag';
                tagBtn.disabled = true;
                tagBtn.style.opacity = '0.5';
                
                console.log(`🔒 Bulk action buttons disabled (no messages selected)`);
            }
        }
        
        // Password confirmation modal — replaces native prompt() so input is masked
        function showPasswordModal(message) {
            return new Promise((resolve) => {
                const modal   = document.getElementById('webhookPasswordModal');
                const input   = document.getElementById('webhookPasswordInput');
                const msgEl   = document.getElementById('webhookPasswordMessage');
                const errorEl = document.getElementById('webhookPasswordError');
                const confirmBtn = document.getElementById('webhookPasswordConfirmBtn');
                const cancelBtn  = document.getElementById('webhookPasswordCancelBtn');

                msgEl.textContent   = message;
                errorEl.textContent = '';
                input.value         = '';
                modal.style.display = 'flex';
                setTimeout(() => input.focus(), 50);

                function cleanup() {
                    modal.style.display = 'none';
                    confirmBtn.removeEventListener('click', onConfirm);
                    cancelBtn.removeEventListener('click', onCancel);
                    input.removeEventListener('keydown', onKeydown);
                }
                function onConfirm() { cleanup(); resolve(input.value.trim() || null); }
                function onCancel()  { cleanup(); resolve(null); }
                function onKeydown(e) {
                    if (e.key === 'Enter')  onConfirm();
                    if (e.key === 'Escape') onCancel();
                }
                confirmBtn.addEventListener('click', onConfirm);
                cancelBtn.addEventListener('click', onCancel);
                input.addEventListener('keydown', onKeydown);
            });
        }

        // Toast notification system with glassmorphism design
        function showToast(message, type = 'info') {
            const toast = document.createElement('div');
            toast.className = 'toast-notification';
            toast.style.cssText = `
                position: fixed;
                bottom: 2rem;
                right: 2rem;
                padding: 1rem 1.5rem;
                background: ${type === 'success' ? 'rgba(16, 185, 129, 0.15)' : type === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)'};
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                border: 1px solid ${type === 'success' ? 'rgba(16, 185, 129, 0.3)' : type === 'error' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(59, 130, 246, 0.3)'};
                border-radius: 12px;
                color: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
                font-weight: 500;
                font-size: 0.95rem;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
                z-index: 10000;
                opacity: 0;
                transform: translateY(20px);
                transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
                pointer-events: none;
            `;
            toast.textContent = message;
            document.body.appendChild(toast);
            
            // Trigger animation
            setTimeout(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translateY(0)';
            }, 10);
            
            // Auto-remove after 3 seconds
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(20px)';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }
        
        // Helper to update book count badge
        function updateBookCount() {
            const bookButton = document.querySelector('[onclick="showTab(\'books\')"]');
            if (bookButton) {
                const badge = bookButton.querySelector('.tab-badge');
                if (badge) {
                    badge.textContent = books.length;
                }
            }
        }

        async function toggleMessages(bookId) {
            console.log('Toggle messages for book:', bookId);
            
            const container = document.getElementById(`messages-${bookId}`);
            const button = document.getElementById(`toggle-btn-${bookId}`);
            
            if (expandedBots.has(bookId)) {
                // Collapse
                expandedBots.delete(bookId);
                container.style.display = 'none';
                button.textContent = '▼ Show Messages';
            } else {
                // Expand
                expandedBots.add(bookId);
                container.style.display = 'block';
                button.textContent = '▲ Hide Messages';
                
                // Load messages if not cached
                if (!messageCache[bookId]) {
                    await loadBookMessages(bookId, false);
                }
            }
        }
        
        // Toggle between custom message view and Discord embed (DISCORD UI EMBEDDING)
        function toggleDiscordEmbed(bookId) {
            const messagesContainer = document.getElementById(`discord-messages-${bookId}`);
            const embedContainer = document.getElementById(`discord-embed-${bookId}`);
            const toggleButton = document.getElementById(`discord-toggle-${bookId}`);
            const searchContainer = document.querySelector(`#msg-search-${bookId}`)?.parentElement;
            
            if (embedContainer.style.display === 'none') {
                // Switch to Discord embed
                messagesContainer.style.display = 'none';
                embedContainer.style.display = 'block';
                toggleButton.textContent = '📋 Custom View';
                toggleButton.title = 'Back to custom message view';
                if (searchContainer) {
                    const inputEl = searchContainer.querySelector('input');
                    const selectEl = searchContainer.querySelector('select');
                    if (inputEl) inputEl.style.display = 'none';
                    if (selectEl) selectEl.style.display = 'none';
                }
            } else {
                // Switch to custom view
                messagesContainer.style.display = 'block';
                embedContainer.style.display = 'none';
                toggleButton.textContent = '🎭 Discord UI';
                toggleButton.title = 'View in Discord (native UI with full features)';
                if (searchContainer) {
                    const inputEl = searchContainer.querySelector('input');
                    const selectEl = searchContainer.querySelector('select');
                    if (inputEl) inputEl.style.display = 'block';
                    if (selectEl) selectEl.style.display = 'block';
                }
            }
        }
        
        // Simplified pagination: fresh load or append older (scroll down)
        // Bidirectional scrolling removed for simplicity - use "Return to latest" after jump
        async function loadBookMessages(bookId, append = false) {
            try {
                if (!messagePageState[bookId]) {
                    messagePageState[bookId] = { isLoading: false, hasOlder: false, seenIds: new Set(), oldestId: null };
                }
                
                if (messagePageState[bookId].isLoading) return;
                messagePageState[bookId].isLoading = true;

                if (!append) _showMsgLoader(bookId);
                
                const effectiveAppend = append && messagePageState[bookId].oldestId;
                
                // Delegate API call to MessagesModule
                const result = await _M.fetchMessages(bookId, {
                    before: effectiveAppend ? messagePageState[bookId].oldestId : null,
                    limit: 50,
                    source: currentViewSource
                });
                
                if (!result.success) {
                    throw new Error(result.error || 'Failed to fetch messages');
                }
                
                const data = { messages: result.messages, hasMore: result.hasMore, oldestMessageId: result.oldestMessageId };
                console.log(`Received ${data.messages?.length || 0} messages`);
                
                // SECURITY: Cache ONLY with tenant-scoped fractal_id
                // This ensures complete tenant isolation in message cache
                if (!effectiveAppend) {
                    messageCache[bookId] = data.messages;
                    // Reset pagination state on fresh load
                    messagePageState[bookId].seenIds = new Set();
                    messagePageState[bookId].hasOlder = data.hasMore === true; // Require explicit true
                    messagePageState[bookId].oldestId = null;
                    // Reset scroll listener flag so it can reattach to new DOM node
                    scrollListenerAttached[bookId] = false;
                } else {
                    // Append older messages to cache
                    messageCache[bookId] = messageCache[bookId] ? [...messageCache[bookId], ...data.messages] : data.messages;
                }
                
                // Re-render Discord-style messages
                const container = document.getElementById(`discord-messages-${bookId}`);
                console.log(`🎯 Container lookup: discord-messages-${bookId}`, container ? 'FOUND' : 'NOT FOUND');
                if (container) {
                    // LENS MODE: Always sync filter state from DOM before filtering
                    // This ensures filter is applied for any active filter (text or status)
                    const existingSearch = document.getElementById(`msg-search-${bookId}`);
                    const statusDropdown = document.getElementById(`status-filter-${bookId}`);
                    lensFilterState[bookId] = {
                        searchText: existingSearch?.value?.trim() || '',
                        statusFilter: statusDropdown?.value || 'all'
                    };
                    
                    // LENS MODE: Filter new batch of messages
                    const filteredMessages = data.messages.filter(msg => {
                        const filter = lensFilterState[bookId] || { searchText: '', statusFilter: 'all' };
                        const msgText = (msg.author?.username || '') + ' ' + (msg.content || '') + ' ' + 
                                       (msg.embeds?.map(e => (e.title || '') + ' ' + (e.description || '')).join(' ') || '');
                        
                        // Check if message content is empty/placeholder
                        if (msg.content === "_(No text content)_") return false;

                        const matchesSearch = window.searchState.performSearch(filter.searchText, msgText);
                        const matchesStatus = filter.statusFilter === 'all' || msg.status === filter.statusFilter;
                        return matchesSearch && matchesStatus;
                    });

                    const html = renderDiscordMessages(filteredMessages, bookId);
                    console.log(`📝 Generated HTML for ${filteredMessages.length} filtered messages`);
                    
                    if (effectiveAppend) {
                        // APPEND older messages at BOTTOM
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = html;
                        while (tempDiv.firstChild) {
                            container.appendChild(tempDiv.firstChild);
                        }
                        console.log(`✅ Appended ${filteredMessages.length} matching messages to bottom`);
                    } else {
                        container.replaceChildren();
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = html;
                        while (tempDiv.firstChild) {
                            container.appendChild(tempDiv.firstChild);
                        }
                        console.log(`✅ Rendered ${filteredMessages.length} matching messages to container`);
                    }
                    
                    // Check for new messages by comparing IDs
                    const seenIds = messagePageState[bookId].seenIds || new Set();
                    let newMessageCount = 0;
                    if (data.messages) {
                        data.messages.forEach(msg => {
                            if (msg.id && !seenIds.has(msg.id)) {
                                seenIds.add(msg.id);
                                newMessageCount++;
                            }
                        });
                    }
                    messagePageState[bookId].seenIds = seenIds;
                    
                    // Store oldestId for cursor-based pagination
                    if (data.oldestMessageId) {
                        messagePageState[bookId].oldestId = data.oldestMessageId;
                    } else if (data.messages?.length > 0) {
                        messagePageState[bookId].oldestId = data.messages[data.messages.length - 1].id;
                    }
                    
                    // Use API's hasMore flag (require explicit true to continue)
                    const apiHasMore = data.hasMore === true;
                    messagePageState[bookId].hasOlder = apiHasMore;
                    
                    console.log(`📊 Pagination: received=${data.messages?.length}, new=${newMessageCount}, apiHasMore=${apiHasMore}, hasOlder=${messagePageState[bookId].hasOlder}, oldestId=${messagePageState[bookId].oldestId}`);
                    
                    // Dynamically create export checkboxes AFTER HTML render
                    // This ensures they're truly interactive and separate from read-only message structure
                    restoreCheckboxStates(bookId);
                    
                    // Hydrate drops (Personal Cloud OS metadata)
                    hydrateDropsForBook(bookId);
                    
                    // SEAMLESS SEARCH: Auto-populate search box if book was opened from message search
                    // NOTE: No longer need to reapply filter - messages are filtered before rendering (lens mode)
                    const searchBox = document.getElementById(`msg-search-${bookId}`);
                    const indicator = document.getElementById(`search-indicator-${bookId}`);
                    
                    if (bookSearchContext.query && bookSearchContext.bookId === bookId && searchBox) {
                        searchBox.value = bookSearchContext.query;
                        // Update lens filter state to match search box
                        lensFilterState[bookId] = { 
                            searchText: bookSearchContext.query, 
                            statusFilter: document.getElementById(`status-filter-${bookId}`)?.value || 'all' 
                        };
                        if (indicator) {
                            indicator.style.display = 'flex';
                        }
                    }
                    
                    // Initialize media lazy loading for this book's messages
                    setTimeout(() => {
                        if (window.initMediaLazyLoading) {
                            window.initMediaLazyLoading();
                        }
                        // Normalize all media images to ensure container query constraints apply
                        normalizeMediaImages(container);
                    }, 100);
                    
                    // Add infinite scroll listener (only once per book, tracked in JS)
                    // Our UI: newest at TOP, oldest at BOTTOM. Scroll DOWN to see older history.
                    if (!scrollListenerAttached[bookId]) {
                        const messagesContainer = document.getElementById(`discord-messages-${bookId}`);
                        if (messagesContainer) {
                            scrollListenerAttached[bookId] = true;
                            console.log(`📜 Infinite scroll listener attached for ${bookId}`);
                            let scrollDebounce = null;
                            messagesContainer.addEventListener('scroll', () => {
                                if (scrollDebounce) return; // Skip if debounce active
                                
                                const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
                                // Distance from bottom in pixels
                                const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
                                const pageState = messagePageState[bookId] || {};
                                
                                // Trigger when within 200px of bottom
                                if (distanceFromBottom < 200) {
                                    if (!pageState.isLoading && pageState.hasOlder === true) {
                                        scrollDebounce = setTimeout(() => { scrollDebounce = null; }, 500);
                                        console.log(`📜 Infinite scroll triggered (${Math.round(distanceFromBottom)}px from bottom) - loading older messages...`);
                                        loadBookMessages(bookId, true);
                                    } else if (!pageState.hasOlder) {
                                        console.log(`📜 Near bottom but hasOlder=false - all messages loaded`);
                                    }
                                }
                            });
                        }
                    }
                } else {
                    console.error(`❌ Container NOT FOUND: discord-messages-${bookId}`);
                }
                
            } catch (error) {
                console.error('Error loading messages:', error);
                const container = document.getElementById(`discord-messages-${bookId}`);
                if (container) {
                    container.replaceChildren();
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'no-messages';
                    errorDiv.style.color = '#ef4444';
                    errorDiv.textContent = 'Error loading messages. Please try refreshing.';
                    container.appendChild(errorDiv);
                }
            } finally {
                // ALWAYS reset loading state to prevent pagination deadlock
                if (messagePageState[bookId]) {
                    messagePageState[bookId].isLoading = false;
                }
            }
        }

        // ====================================
        // JUMP-TO-MESSAGE & SMART POLLING
        // ====================================

        // Jump to specific message with context window
        async function jumpToMessage(targetId, bookId) {
            if (!targetId || !bookId) return;
            
            try {
                console.log(`🎯 Jumping to message ${targetId}...`);
                clearSearchState(bookId);
                
                // Delegate context fetch to MessagesModule
                const result = await _M.fetchMessageContext(targetId, bookId);
                
                if (!result.success || result.messages.length === 0) {
                    showToast(`⚠️ Message not found`, 'error');
                    return;
                }
                
                const contextMessages = result.messages;
                console.log(`📦 Got ${contextMessages.length} context messages, rendering view...`);
                
                // ANCHOR APPROACH: Replace container with context messages (centered on target)
                // This is book/length agnostic - we just show the context around the target
                const container = document.getElementById(`discord-messages-${bookId}`);
                if (container) {
                    // Render context messages using existing render function
                    const html = renderDiscordMessages(contextMessages, bookId);
                    container.replaceChildren();
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = html;
                    while (tempDiv.firstChild) {
                        container.appendChild(tempDiv.firstChild);
                    }
                    
                    // Update cache with context messages
                    messageCache[bookId] = contextMessages;
                    
                    // Set pagination state for context view (can scroll down to load older)
                    messagePageState[bookId] = {
                        isLoading: false,
                        hasOlder: true,  // Allow scrolling down for older after jump
                        oldestId: contextMessages[contextMessages.length - 1]?.id,
                        seenIds: new Set(contextMessages.map(m => m.id))
                    };
                    
                    // Reset scroll listener flag so it can reattach to new DOM node
                    scrollListenerAttached[bookId] = false;
                    
                    // Show "Return to latest" affordance so user can go back
                    showReturnToLatestButton(bookId);
                }
                
                // Wait for DOM to update, then scroll
                await new Promise(resolve => setTimeout(resolve, 100));
                requestAnimationFrame(() => {
                    const targetEl = document.querySelector(`.discord-message[data-msg-id="${targetId}"]`);
                    if (targetEl) {
                        console.log(`✅ Target found, scrolling...`);
                        scrollAndHighlight(targetEl, bookId);
                        
                        // Defer drops hydration to run AFTER scroll completes (non-blocking)
                        setTimeout(() => hydrateDropsForBook(bookId), 500);
                    } else {
                        console.warn(`⚠️ Message ${targetId} not in DOM after render`);
                        showToast(`⚠️ Message not found`, 'error');
                    }
                });
                
            } catch (error) {
                console.error('Error jumping to message:', error);
                showToast(`⚠️ Error jumping to message`, 'error');
            }
        }
        
        // Clear search state and UI indicators
        function clearSearchState(bookId) {
            // Clear search input
            const searchBox = document.getElementById(`msg-search-${bookId}`);
            if (searchBox) {
                searchBox.value = '';
            }
            
            // Hide search indicator
            const indicator = document.getElementById(`search-indicator-${bookId}`);
            if (indicator) {
                indicator.style.display = 'none';
            }
            
            // Clear bookSearchContext if it matches this book
            if (bookSearchContext.bookId === bookId) {
                bookSearchContext.query = '';
                bookSearchContext.bookId = null;
            }
            
            // Clear lens filter state directly (no re-render - caller will reload if needed)
            lensFilterState[bookId] = { searchText: '', statusFilter: 'all' };
            
            // Remove any search preview containers
            const previewContainers = document.querySelectorAll(`#discord-messages-${bookId} .search-preview-container`);
            previewContainers.forEach(c => c.remove());
            
            // Reset status filter dropdown
            const statusDropdown = document.getElementById(`status-filter-${bookId}`);
            if (statusDropdown) {
                statusDropdown.value = 'all';
            }
        }
        
        // Show "Return to latest" button when viewing old messages after jump
        function showReturnToLatestButton(bookId) {
            const container = document.getElementById(`discord-messages-${bookId}`);
            if (!container) return;
            
            // Attach to the wrapper (container's parent), not the scrollable container itself.
            // position:sticky inside a scroll container occupies layout space and pushes messages
            // down. Attaching to the wrapper as position:absolute overlays without any reflow.
            const wrapper = container.parentElement;
            if (!wrapper) return;
            
            // Remove existing button if any
            const existing = wrapper.querySelector('.return-to-latest-btn');
            if (existing) existing.remove();
            
            // Ensure wrapper is a positioned ancestor for absolute child
            if (!wrapper.style.position) wrapper.style.position = 'relative';
            
            const btn = document.createElement('button');
            btn.className = 'return-to-latest-btn';
            btn.innerHTML = '↑ Return to Latest';
            btn.style.cssText = `
                position: absolute;
                top: 8px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 100;
                padding: 6px 16px;
                background: rgba(59, 130, 246, 0.9);
                border: 1px solid rgba(59, 130, 246, 0.5);
                border-radius: 20px;
                color: white;
                font-size: 0.8125rem;
                cursor: pointer;
                backdrop-filter: blur(8px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                transition: all 0.2s;
                white-space: nowrap;
                pointer-events: auto;
            `;
            
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Loading...';
                messagePageState[bookId] = { isLoading: false, hasOlder: false, seenIds: new Set(), oldestId: null };
                await loadBookMessages(bookId, false);
                btn.remove();
            });
            
            // Append to wrapper — overlays messages without affecting layout
            wrapper.appendChild(btn);
        }
        
        // Hide "Return to latest" button
        function hideReturnToLatestButton(bookId) {
            const container = document.getElementById(`discord-messages-${bookId}`);
            const wrapper = container?.parentElement;
            const btn = wrapper?.querySelector('.return-to-latest-btn') ||
                       container?.querySelector('.return-to-latest-btn');
            if (btn) btn.remove();
        }

        // Insert context messages around target without duplicates
        async function insertContextMessages(messages, targetId, bookId) {
            const container = document.getElementById(`discord-messages-${bookId}`);
            if (!container) return;
            
            // Find target message in fetched context
            const targetIndex = messages.findIndex(m => m.id === targetId);
            if (targetIndex === -1) return;
            
            const before = messages.slice(0, targetIndex);
            const target = messages[targetIndex];
            const after = messages.slice(targetIndex + 1);
            
            // Render messages if they don't exist in DOM
            for (const msg of [...before, target, ...after]) {
                const existing = document.querySelector(`.discord-message[data-msg-id="${msg.id}"]`);
                if (!existing) {
                    // Render single message HTML
                    const searchableText = [
                        msg.sender_name || '',
                        msg.message_content || '',
                        msg.sender_contact || '',
                        extractEmbedSearchText(msg.embeds || []),
                        (msg.extracted_tags || []).map(t => '#' + t).join(' ')
                    ].join(' ').toLowerCase();
                    
                    const html = `
                    <div class="discord-message" data-msg-id="${escapeHtml(msg.id)}" data-search-text="${escapeHtml(searchableText)}" data-status="${escapeHtml(msg.discord_status || 'success')}" style="position: relative;">
                        <div style="position: absolute; top: 8px; right: 8px; display: flex; align-items: center; gap: 8px; z-index: 10;">
                            ${msg.media_url ? `
                                <a href="${escapeHtml(msg.media_url)}" download title="Download attachment" style="display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: rgba(59, 130, 246, 0.2); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 4px; color: #60a5fa; text-decoration: none; font-size: 0.875rem; transition: all 0.2s; flex-shrink: 0; line-height: 1;">
                                    📎
                                </a>
                            ` : ''}
                            <button class="agent-btn" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}" title="🧿 Audit action & closure" style="display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: rgba(148, 163, 184, 0.2); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 4px; color: #cbd5e1; font-size: 0.875rem; transition: all 0.2s; flex-shrink: 0; cursor: pointer; margin: 0; padding: 0; line-height: 1;">
                                🧿
                            </button>
                            <button class="tag-add-btn" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}" title="Add tags" style="display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: rgba(148, 163, 184, 0.2); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 4px; color: #cbd5e1; font-size: 0.875rem; transition: all 0.2s; flex-shrink: 0; cursor: pointer; margin: 0; padding: 0; line-height: 1;">
                                🏷️
                            </button>
                            <label class="custom-checkbox-btn" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}" title="Select for export" style="position: relative; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: rgba(148, 163, 184, 0.2); border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 4px; color: #cbd5e1; font-size: 0.875rem; cursor: pointer; margin: 0; padding: 0; flex-shrink: 0; transition: all 0.2s; line-height: 1;">
                                <input type="checkbox" class="message-export-checkbox message-checkbox" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}" style="display: none;">
                                <span class="checkbox-icon" style="font-size: 0.875rem; line-height: 1; pointer-events: none;">☐</span>
                            </label>
                        </div>
                        <div class="discord-avatar">
                            ${msg.sender_photo_url ? 
                                `<img src="${escapeHtml(msg.sender_photo_url)}" alt="${escapeHtml(msg.sender_name || 'User')}" class="avatar-photo" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">
                                 <div class="avatar-fallback" style="display: none; width: 100%; height: 100%; align-items: center; justify-content: center;">${escapeHtml(msg.sender_name ? msg.sender_name.charAt(0).toUpperCase() : '?')}</div>` :
                                `${escapeHtml(msg.sender_name ? msg.sender_name.charAt(0).toUpperCase() : '?')}`
                            }
                        </div>
                        <div class="discord-content">
                            <div class="discord-header-row">
                                <span class="discord-username">${escapeHtml(msg.sender_name || 'Unknown')}</span>
                                ${msg.sender_contact ? `<span class="sender-role" title="${msg.is_creator ? 'Book Creator' : 'Contributor'}" style="color: ${msg.is_creator ? '#22c55e' : '#60a5fa'};">${msg.is_creator ? '🌟' : '👥'}</span>` : ''}
                                <span class="discord-timestamp">${formatDiscordTime(msg.timestamp)}</span>
                                <span class="discord-status-badge status-${escapeHtml(msg.discord_status || 'success')}">${msg.discord_status === 'success' ? '✓' : msg.discord_status === 'failed' ? '✗' : '⏳'}</span>
                            </div>
                            <div class="message-drop-section" data-message-id="${escapeHtml(msg.id)}" data-book-id="${escapeHtml(bookId)}">
                                <div class="drop-display hidden"></div>
                            </div>
                            ${msg.message_content ? `<div class="discord-text">${escapeHtml(msg.message_content)}</div>` : ''}
                            ${msg.has_media ? `
                                <div class="discord-media-preview" id="media-preview-${escapeHtml(msg.id)}" data-message-id="${escapeHtml(msg.id)}" data-media-url="${escapeHtml(msg.media_url || '')}" data-media-type="${escapeHtml(msg.media_type || '')}">
                                    <div class="media-loading">Loading media...</div>
                                </div>
                            ` : ''}
                        </div>
                    </div>`;
                    
                    // Insert at appropriate position (maintain chronological order)
                    container.insertAdjacentHTML('beforeend', html);
                }
            }
            
            // Hydrate drops for new messages
            hydrateDropsForBook(bookId);
        }

        // Scroll to element with offset for sticky time header
        // Handles async image loading to ensure accurate scroll position
        function scrollAndHighlight(el, bookIdParam) {
            console.log(`🎨 scrollAndHighlight called, el exists:`, !!el, `bookId param:`, bookIdParam);
            if (!el) return;
            
            const msgId = el.getAttribute('data-msg-id');
            
            // Use passed bookId parameter (reliable) or fallback to detection
            let bookId = bookIdParam || el.getAttribute('data-book-id');
            
            // Fallback: try to find from parent container
            if (!bookId) {
                const parentContainer = el.closest('[id^="discord-messages-"]');
                if (parentContainer) {
                    bookId = parentContainer.id.replace('discord-messages-', '');
                }
            }
            
            console.log(`📊 msgId=${msgId}, bookId=${bookId}`);
            
            const container = bookId ? document.getElementById(`discord-messages-${bookId}`) : null;
            console.log(`📦 Container found:`, !!container);
            
            if (container) {
                // FIXED OFFSET: Time bar height is constant, no need for dynamic calculation
                const FIXED_OFFSET = 56; // Time bar height (40px) + minimal padding (16px)
                
                // Helper function to calculate and apply scroll
                const applyScroll = (label) => {
                    const containerRect = container.getBoundingClientRect();
                    const elRect = el.getBoundingClientRect();
                    const elTopRelativeToContainer = elRect.top - containerRect.top;
                    const scrollTarget = container.scrollTop + elTopRelativeToContainer - FIXED_OFFSET;
                    container.scrollTop = Math.max(0, scrollTarget);
                    console.log(`📐 ${label}: scrollTop = ${container.scrollTop}px (offset=${FIXED_OFFSET}px)`);
                };
                
                // STEP 1: Immediate scroll snap
                applyScroll('STEP 1 - Initial snap');
                
                // STEP 2: Wait for ALL images in this message to fully load, then re-snap
                const images = el.querySelectorAll('img');
                
                // Attach onload handlers to all images (including future lazy-loaded ones)
                const attachLoadHandler = (img) => {
                    if (!img.complete) {
                        img.addEventListener('load', () => {
                            applyScroll('Post-image-load correction');
                        }, { once: true });
                        img.addEventListener('error', () => {
                            applyScroll('Post-image-error correction');
                        }, { once: true });
                    }
                };
                
                images.forEach(attachLoadHandler);
                
                // Also watch for dynamically added images via MutationObserver
                const observer = new MutationObserver((mutations) => {
                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeName === 'IMG') {
                                attachLoadHandler(node);
                            } else if (node.querySelectorAll) {
                                node.querySelectorAll('img').forEach(attachLoadHandler);
                            }
                        }
                    }
                });
                
                observer.observe(el, { childList: true, subtree: true });
                
                // Stop observing after 5 seconds (safety limit)
                setTimeout(() => {
                    observer.disconnect();
                }, 5000);
                
                // STEP 3: Scheduled corrections for layout shifts
                setTimeout(() => applyScroll('STEP 2 - 100ms correction'), 100);
                setTimeout(() => applyScroll('STEP 3 - 300ms correction'), 300);
                setTimeout(() => applyScroll('STEP 4 - 1s final correction'), 1000);
                
                // Add highlight animation to make the target message visible
                el.classList.add('jump-highlight');
                setTimeout(() => {
                    el.classList.remove('jump-highlight');
                }, 2000);
            } else {
                console.log(`⚠️ No container found, using scrollIntoView fallback`);
                el.scrollIntoView({ behavior: 'auto', block: 'start' });
            }
            
            // Update URL with hash (for shareable links)
            if (msgId) {
                history.pushState(null, '', `#msg-${msgId}`);
            }
        }

        let _pollTimer = null;
        let _pollBookId = null;

        function startPolling(bookId) {
            stopPolling();
            _pollBookId = bookId;
            _pollTimer = setInterval(() => _pollTick(), 15000);
        }

        async function _pollTick() {
            if (document.hidden || !_pollBookId) return;
            const bookId = _pollBookId;
            try {
                const container = document.getElementById(`discord-messages-${bookId}`);
                if (!container) return;
                const msgs = container.querySelectorAll('.discord-message');
                if (msgs.length === 0) return;
                const lastMsgId = msgs[msgs.length - 1]?.getAttribute('data-msg-id');
                if (!lastMsgId) return;

                const response = await window.authFetch(`/api/books/${bookId}/messages?after=${lastMsgId}&source=${currentViewSource}`);
                if (!response.ok) return;

                const data = await response.json();
                const newMessages = data.messages || [];
                if (newMessages.length === 0) return;

                console.log(`🔄 Poll: ${newMessages.length} new`);

                const filter = lensFilterState[bookId] || { searchText: '', statusFilter: 'all' };
                const filteredNewMessages = newMessages.filter(msg => {
                    const msgText = (msg.author?.username || '') + ' ' + (msg.content || '') + ' ' +
                                   (msg.embeds?.map(e => (e.title || '') + ' ' + (e.description || '')).join(' ') || '');
                    if (msg.content === "_(No text content)_") return false;
                    const matchesSearch = window.searchState.performSearch(filter.searchText, msgText);
                    const matchesStatus = filter.statusFilter === 'all' || msg.status === filter.statusFilter;
                    return matchesSearch && matchesStatus;
                });

                if (messageCache[bookId]) {
                    messageCache[bookId] = [...newMessages, ...messageCache[bookId]];
                }

                for (const msg of filteredNewMessages) {
                    if (!container.querySelector(`.discord-message[data-msg-id="${msg.id}"]`)) {
                        await insertContextMessages([msg], msg.id, bookId);
                    }
                }
            } catch (error) {
                console.error('Poll error:', error);
            }
        }

        function stopPolling() {
            if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
            _pollBookId = null;
        }

        // URL hash support for shareable links
        function initUrlHashSupport() {
            // Check for hash on page load
            if (window.location.hash && window.location.hash.startsWith('#msg-')) {
                const msgId = window.location.hash.substring(5); // Remove '#msg-'
                const bookId = selectedBookFractalId;
                
                if (msgId && bookId) {
                    setTimeout(() => {
                        jumpToMessage(msgId, bookId);
                    }, 500);
                }
            }
            
            // Handle back/forward navigation
            window.addEventListener('popstate', () => {
                if (window.location.hash && window.location.hash.startsWith('#msg-')) {
                    const msgId = window.location.hash.substring(5);
                    const bookId = selectedBookFractalId;
                    
                    if (msgId && bookId) {
                        jumpToMessage(msgId, bookId);
                    }
                }
            });
        }

        // Load and display inline media preview - delegates API to MessagesModule
        async function loadMediaPreview(messageId) {
            const previewContainer = document.getElementById(`media-preview-${messageId}`);
            if (!previewContainer) return;
            
            const result = await _M.fetchMedia(messageId);
            previewContainer.replaceChildren();
            
            if (!result.success) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'media-error';
                errorDiv.textContent = 'Media unavailable';
                previewContainer.appendChild(errorDiv);
                return;
            }
            
            const mediaType = (result.mediaType || '').toLowerCase();
            const mediaData = result.mediaData;
            
            if (mediaType.includes('image')) {
                const img = document.createElement('img');
                img.src = mediaData;
                img.alt = 'Image attachment';
                img.className = 'discord-media-image';
                img.dataset.messageId = messageId;
                img.loading = 'lazy';
                img.style.cursor = 'pointer';
                previewContainer.appendChild(img);
            } else if (mediaType.includes('video')) {
                const video = document.createElement('video');
                video.controls = true;
                video.className = 'discord-media-video';
                const source = document.createElement('source');
                source.src = mediaData;
                source.type = result.mediaType;
                video.appendChild(source);
                video.appendChild(document.createTextNode("Your browser doesn't support video playback."));
                previewContainer.appendChild(video);
                
                const hint = document.createElement('div');
                hint.className = 'media-expand-hint';
                hint.dataset.messageId = messageId;
                hint.style.cursor = 'pointer';
                hint.textContent = 'Click to view fullscreen';
                previewContainer.appendChild(hint);
            } else if (mediaType.includes('audio')) {
                const audio = document.createElement('audio');
                audio.controls = true;
                audio.className = 'discord-media-audio';
                const source = document.createElement('source');
                source.src = mediaData;
                source.type = result.mediaType;
                audio.appendChild(source);
                audio.appendChild(document.createTextNode("Your browser doesn't support audio playback."));
                previewContainer.appendChild(audio);
            } else {
                const attachDiv = document.createElement('div');
                attachDiv.className = 'discord-attachment';
                attachDiv.dataset.messageId = messageId;
                attachDiv.style.cursor = 'pointer';
                const iconSpan = document.createElement('span');
                iconSpan.className = 'attachment-icon';
                iconSpan.textContent = '📎';
                const typeSpan = document.createElement('span');
                typeSpan.className = 'attachment-type';
                typeSpan.textContent = result.mediaType || 'Attachment';
                attachDiv.appendChild(iconSpan);
                attachDiv.appendChild(typeSpan);
                previewContainer.appendChild(attachDiv);
            }
        }

        // Helper function to show persistent download status
        function showDownloadStatus(message, type = 'info') {
            let statusEl = document.getElementById('downloadStatus');
            if (!statusEl) {
                statusEl = document.createElement('div');
                statusEl.id = 'downloadStatus';
                statusEl.style.cssText = `
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    background: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 12px 20px;
                    border-radius: 8px;
                    font-size: 14px;
                    z-index: 10000;
                    max-width: 300px;
                    word-wrap: break-word;
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                `;
                document.body.appendChild(statusEl);
            }
            
            // Set background color based on type
            if (type === 'error') {
                statusEl.style.background = 'rgba(239, 68, 68, 0.9)';
                statusEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
            } else if (type === 'success') {
                statusEl.style.background = 'rgba(34, 197, 94, 0.9)';
                statusEl.style.borderColor = 'rgba(34, 197, 94, 0.3)';
            } else {
                statusEl.style.background = 'rgba(0, 0, 0, 0.8)';
                statusEl.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            }
            
            statusEl.textContent = message;
            statusEl.style.display = 'block';
            return statusEl;
        }

        // Download entire book as ZIP archive
        async function downloadEntireBook(fractalId) {
            try {
                showDownloadStatus('⬇️ Preparing book download...', 'info');
                console.log('⬇️ Starting download for book:', fractalId);
                
                let accessToken = localStorage.getItem('accessToken');
                
                // Use direct fetch for binary data to avoid JSON header issues
                let response = await fetch(`/api/books/${fractalId}/export`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                });
                
                // If token expired (401), try to refresh and retry
                if (response.status === 401) {
                    console.log('⬇️ Token expired, attempting refresh...');
                    const refreshToken = localStorage.getItem('refreshToken');
                    
                    if (refreshToken) {
                        const refreshResponse = await fetch('/api/auth/refresh', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ refreshToken })
                        });
                        
                        if (refreshResponse.ok) {
                            const refreshData = await refreshResponse.json();
                            localStorage.setItem('accessToken', refreshData.accessToken);
                            if (refreshData.refreshToken) {
                                localStorage.setItem('refreshToken', refreshData.refreshToken);
                            }
                            accessToken = refreshData.accessToken;
                            console.log('⬇️ Token refreshed, retrying download...');
                            
                            // Retry the download with new token
                            response = await fetch(`/api/books/${fractalId}/export`, {
                                method: 'GET',
                                headers: {
                                    'Authorization': `Bearer ${accessToken}`
                                }
                            });
                        } else {
                            // Refresh failed, redirect to login
                            localStorage.removeItem('accessToken');
                            localStorage.removeItem('refreshToken');
                            window.location.href = '/login.html';
                            return;
                        }
                    } else {
                        // No refresh token, redirect to login
                        window.location.href = '/login.html';
                        return;
                    }
                }
                
                showDownloadStatus('⬇️ Downloading data...', 'info');
                console.log('⬇️ Response status:', response.status);
                console.log('⬇️ Response headers:', {
                    'content-type': response.headers.get('content-type'),
                    'content-disposition': response.headers.get('content-disposition'),
                    'content-length': response.headers.get('content-length')
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                showDownloadStatus('⬇️ Creating ZIP file...', 'info');
                const blob = await response.blob();
                console.log('⬇️ Blob created:', {
                    size: blob.size,
                    type: blob.type
                });
                
                if (blob.size === 0) {
                    throw new Error('Downloaded file is empty');
                }
                
                // Create download link and trigger download
                showDownloadStatus('⬇️ Triggering download...', 'info');
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${fractalId}-complete-book.zip`;
                
                console.log('⬇️ Triggering download with filename:', link.download);
                
                // Must be in DOM to work on some browsers
                document.body.appendChild(link);
                
                // Add small delay to ensure DOM is ready
                setTimeout(() => {
                    link.click();
                    console.log('⬇️ Download click triggered');
                    
                    // Show success message
                    showDownloadStatus('✅ Book downloaded successfully', 'success');
                    
                    // Cleanup
                    setTimeout(() => {
                        document.body.removeChild(link);
                        URL.revokeObjectURL(url);
                    }, 100);
                    
                    // Auto-hide success message after 5 seconds
                    setTimeout(() => {
                        const statusEl = document.getElementById('downloadStatus');
                        if (statusEl) {
                            statusEl.style.display = 'none';
                        }
                    }, 5000);
                }, 50);
            } catch (error) {
                console.error('❌ Download error:', error);
                showDownloadStatus(`❌ Download failed: ${error.message}`, 'error');
            }
        }

        function openCreateUserModal() {
            const roleSelect = document.getElementById('userRole');
            roleSelect.replaceChildren();
            
            const roles = currentUser.role === 'dev' 
                ? [
                    { value: 'dev', label: 'Dev (Full Access)' },
                    { value: 'admin', label: 'Admin (Tenant Manager)' },
                    { value: 'read-only', label: 'Read-Only (View Only)', selected: true },
                    { value: 'write-only', label: 'Write-Only (Create/Edit)' }
                ]
                : [
                    { value: 'read-only', label: 'Read-Only (View Only)', selected: true },
                    { value: 'write-only', label: 'Write-Only (Create/Edit)' }
                ];
            
            roles.forEach(role => {
                const option = document.createElement('option');
                option.value = role.value;
                option.textContent = role.label;
                if (role.selected) option.selected = true;
                roleSelect.appendChild(option);
            });
            
            document.getElementById('userModal').classList.add('active');
        }

        function closeUserModal() {
            document.getElementById('userModal').classList.remove('active');
        }

        async function saveUser(event) {
            event.preventDefault();
            
            const userData = {
                email: document.getElementById('userEmail').value,
                password: document.getElementById('userPassword').value,
                role: document.getElementById('userRole').value
            };

            try {
                const response = await window.authFetch('/api/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(userData)
                });

                if (response.ok) {
                    closeUserModal();
                    loadAdminCards(); // Updated to use new function
                    loadDevPanelAdmins(); // Also refresh dev panel if visible
                    document.getElementById('userForm').reset();
                } else {
                    const error = await response.json();
                    alert(error.error || 'Failed to create user');
                }
            } catch (error) {
                console.error('Error creating user:', error);
                alert('Error creating user');
            }
        }

        async function changeUserRole(userId, newRole) {
            try {
                const response = await window.authFetch(`/api/users/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role: newRole })
                });

                if (response.ok) {
                    loadAdminCards(); // Updated to use new function
                    loadDevPanelAdmins(); // Also refresh dev panel if visible
                } else {
                    alert('Failed to update user role');
                }
            } catch (error) {
                console.error('Error updating user role:', error);
            }
        }

        function deleteUser(userId) {
            nyanConfirm('Delete this user?', 'This action cannot be undone.', async () => {
                try {
                    const response = await window.authFetch(`/api/users/${userId}`, { method: 'DELETE' });
                    if (response.ok) {
                        loadAdminCards();
                        loadDevPanelAdmins();
                    } else {
                        alert('Failed to delete user');
                    }
                } catch (error) {
                    console.error('Error deleting user:', error);
                }
            });
        }

        function changeUserEmail(userId, currentEmail) {
            document.getElementById('changeEmailUserId').value = userId;
            document.getElementById('currentEmailDisplay').value = currentEmail;
            document.getElementById('newEmail').value = '';
            document.getElementById('changeEmailModal').classList.add('active');
        }

        function closeChangeEmailModal() {
            document.getElementById('changeEmailModal').classList.remove('active');
        }

        async function saveNewEmail(event) {
            event.preventDefault();
            
            const userId = document.getElementById('changeEmailUserId').value;
            const newEmail = document.getElementById('newEmail').value.trim();

            // Client-side validation
            if (!newEmail) {
                alert('Email is required');
                return;
            }
            
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(newEmail)) {
                alert('Please enter a valid email address');
                return;
            }

            try {
                const response = await window.authFetch(`/api/users/${userId}/email`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: newEmail })
                });

                if (response.ok) {
                    closeChangeEmailModal();
                    loadUsers();
                    alert('Email updated successfully!');
                } else {
                    const error = await response.json();
                    alert(error.error || 'Failed to update email');
                }
            } catch (error) {
                console.error('Error updating email:', error);
                alert('Error updating email');
            }
        }

        function changeUserPassword(userId) {
            document.getElementById('changePasswordUserId').value = userId;
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
            document.getElementById('changePasswordModal').classList.add('active');
        }

        function closeChangePasswordModal() {
            document.getElementById('changePasswordModal').classList.remove('active');
        }

        async function saveNewPassword(event) {
            event.preventDefault();
            
            const userId = document.getElementById('changePasswordUserId').value;
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;

            // Client-side validation
            if (!newPassword || !newPassword.trim()) {
                alert('Password is required');
                return;
            }
            
            if (newPassword.length < 6) {
                alert('Password must be at least 6 characters long');
                return;
            }

            if (newPassword !== confirmPassword) {
                alert('Passwords do not match!');
                return;
            }

            try {
                const response = await window.authFetch(`/api/users/${userId}/password`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: newPassword })
                });

                if (response.ok) {
                    closeChangePasswordModal();
                    alert('Password updated successfully!');
                } else {
                    const error = await response.json();
                    alert(error.error || 'Failed to update password');
                }
            } catch (error) {
                console.error('Error updating password:', error);
                alert('Error updating password');
            }
        }

        // Session Management
        async function loadSessions() {
            const sessionsList = document.getElementById('sessionsList');
            
            try {
                const locationFilter = document.getElementById('sessionLocationFilter')?.value || '';
                const deviceFilter = document.getElementById('sessionDeviceFilter')?.value || '';
                const browserFilter = document.getElementById('sessionBrowserFilter')?.value || '';
                const sortBy = document.getElementById('sessionSortBy')?.value || 'login_time';
                const sortOrder = document.getElementById('sessionSortOrder')?.value || 'desc';
                
                const params = new URLSearchParams();
                if (locationFilter) params.append('filterLocation', locationFilter);
                if (deviceFilter) params.append('filterDevice', deviceFilter);
                if (browserFilter) params.append('filterBrowser', browserFilter);
                params.append('sortBy', sortBy);
                params.append('sortOrder', sortOrder);
                
                const response = await window.authFetch(`/api/sessions?${params}`);
                if (!response.ok) {
                    throw new Error(`Failed to load sessions: ${response.status}`);
                }
                
                const data = await response.json();
                
                if (!data.sessions || data.sessions.length === 0) {
                    sessionsList.replaceChildren();
                    const emptyMsg = document.createElement('p');
                    emptyMsg.style.cssText = 'text-align: center; color: #94a3b8; padding: 3rem;';
                    emptyMsg.textContent = 'No active sessions found. Sessions will appear here when users log in.';
                    sessionsList.appendChild(emptyMsg);
                    return;
                }
                
                sessionsList.replaceChildren();
                data.sessions.forEach(session => {
                    const card = document.createElement('div');
                    card.className = 'user-card';
                    card.style.opacity = session.is_active ? '1' : '0.6';
                    
                    const userInfo = document.createElement('div');
                    userInfo.className = 'user-info';
                    const userEmail = document.createElement('div');
                    userEmail.className = 'user-email';
                    userEmail.textContent = session.email || session.phone || 'Unknown User';
                    const userRole = document.createElement('div');
                    userRole.className = 'user-role';
                    const statusSpan = document.createElement('span');
                    statusSpan.style.cssText = session.is_active ? 'color: #10b981; font-weight: 600;' : 'color: #94a3b8;';
                    statusSpan.textContent = session.is_active ? '● Active' : '○ Inactive';
                    userRole.appendChild(statusSpan);
                    userInfo.appendChild(userEmail);
                    userInfo.appendChild(userRole);
                    
                    const details = document.createElement('div');
                    details.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; margin-top: 0.75rem; font-size: 0.875rem; color: #cbd5e1;';
                    
                    const fields = [
                        { label: 'Device:', value: session.device_type || 'Unknown' },
                        { label: 'Browser:', value: session.browser || 'Unknown' },
                        { label: 'OS:', value: session.os || 'Unknown' },
                        { label: 'IP:', value: session.ip_address || 'Unknown' },
                        { label: 'Location:', value: '🌍 ' + (session.location || 'Unknown Location') },
                        { label: 'Login:', value: new Date(session.login_time).toLocaleString() },
                        { label: 'Last Activity:', value: new Date(session.last_activity).toLocaleString() }
                    ];
                    
                    fields.forEach(field => {
                        const div = document.createElement('div');
                        const strong = document.createElement('strong');
                        strong.textContent = field.label;
                        div.appendChild(strong);
                        div.appendChild(document.createTextNode(' ' + field.value));
                        details.appendChild(div);
                    });
                    
                    const actions = document.createElement('div');
                    actions.className = 'user-actions';
                    if (session.is_active) {
                        const btn = document.createElement('button');
                        btn.className = 'btn btn-delete';
                        btn.dataset.revokeSession = session.id;
                        btn.textContent = 'Revoke';
                        actions.appendChild(btn);
                    }
                    
                    card.appendChild(userInfo);
                    card.appendChild(details);
                    card.appendChild(actions);
                    sessionsList.appendChild(card);
                });
            } catch (error) {
                console.error('Error loading sessions:', error);
                if (sessionsList) {
                    sessionsList.replaceChildren();
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'text-align: center; padding: 3rem; color: #ef4444;';
                    errorDiv.textContent = 'Error loading sessions. Please try refreshing the page.';
                    sessionsList.appendChild(errorDiv);
                }
            }
        }

        function revokeSession(sessionId) {
            nyanConfirm('Revoke this session?', 'The user will be logged out immediately.', async () => {
                try {
                    const response = await window.authFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
                    if (response.ok) {
                        loadSessions();
                        alert('Session revoked successfully');
                    } else {
                        alert('Failed to revoke session');
                    }
                } catch (error) {
                    console.error('Error revoking session:', error);
                    alert('Error revoking session');
                }
            });
        }

        function revokeAllSessions() {
            nyanConfirm('Revoke ALL sessions?', 'All other users will be logged out immediately. Your current session is preserved.', async () => {
                try {
                    const response = await window.authFetch('/api/sessions/revoke-all', { 
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({})
                    });
                    
                    if (response.ok) {
                        const data = await response.json();
                        loadSessions();
                        alert(`Successfully revoked ${data.count} session(s)`);
                    } else {
                        alert('Failed to revoke all sessions');
                    }
                } catch (error) {
                    console.error('Error revoking all sessions:', error);
                    alert('Error revoking all sessions');
                }
            });
        }

        // Load Dev Panel (dev role only)
        async function loadAdminPanel() {
            if (!currentUser || currentUser.role !== 'dev') {
                return;
            }

            // Load users
            try {
                const usersResponse = await window.authFetch('/api/users');
                if (usersResponse.ok) {
                    const users = await usersResponse.json();
                    renderAdminUsers(users);
                }
            } catch (error) {
                console.error('Error loading users for admin panel:', error);
                const userList = document.getElementById('adminUserList');
                if (userList) {
                    userList.replaceChildren();
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'color: #ef4444; text-align: center; padding: 1rem;';
                    errorDiv.textContent = 'Error loading users';
                    userList.appendChild(errorDiv);
                }
            }

            // Load sessions
            try {
                const sessionsResponse = await window.authFetch('/api/sessions');
                if (sessionsResponse.ok) {
                    const sessions = await sessionsResponse.json();
                    renderAdminSessions(sessions);
                }
            } catch (error) {
                console.error('Error loading sessions for admin panel:', error);
                const sessionsList = document.getElementById('adminSessionsList');
                if (sessionsList) {
                    sessionsList.replaceChildren();
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'color: #ef4444; text-align: center; padding: 1rem;';
                    errorDiv.textContent = 'Error loading sessions';
                    sessionsList.appendChild(errorDiv);
                }
            }

            // Load audit logs
            try {
                const filter = document.getElementById('auditLogFilter')?.value || 'all';
                const params = filter !== 'all' ? `?action_type=${filter}` : '?limit=50';
                const auditResponse = await window.authFetch(`/api/audit-logs${params}`);
                if (auditResponse.ok) {
                    const auditLogs = await auditResponse.json();
                    renderAdminAuditLogs(auditLogs);
                }
            } catch (error) {
                console.error('Error loading audit logs for admin panel:', error);
                const auditLogs = document.getElementById('adminAuditLogs');
                if (auditLogs) {
                    auditLogs.replaceChildren();
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'color: #ef4444; text-align: center; padding: 1rem;';
                    errorDiv.textContent = 'Error loading audit logs';
                    auditLogs.appendChild(errorDiv);
                }
            }
        }

        function renderAdminUsers(users) {
            const container = document.getElementById('adminUserList');
            container.replaceChildren();
            
            if (!users || users.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.style.cssText = 'text-align: center; padding: 1rem; color: #94a3b8;';
                emptyDiv.textContent = 'No users found';
                container.appendChild(emptyDiv);
                return;
            }

            const roleColors = {
                'admin': '#10b981',
                'read-only': '#f59e0b',
                'write-only': '#3b82f6'
            };

            users.forEach(user => {
                const card = document.createElement('div');
                card.style.cssText = 'padding: 0.75rem; margin-bottom: 0.5rem; background: rgba(255, 255, 255, 0.05); border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.1);';
                
                const flex = document.createElement('div');
                flex.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
                
                const info = document.createElement('div');
                const emailDiv = document.createElement('div');
                emailDiv.style.cssText = 'font-weight: 600; color: white;';
                emailDiv.textContent = user.email || user.phone;
                
                const metaDiv = document.createElement('div');
                metaDiv.style.cssText = 'font-size: 0.75rem; color: #94a3b8; margin-top: 0.25rem;';
                metaDiv.appendChild(document.createTextNode('ID: ' + user.id + ' • Role: '));
                const roleSpan = document.createElement('span');
                roleSpan.style.color = roleColors[user.role] || '#94a3b8';
                roleSpan.textContent = user.role;
                metaDiv.appendChild(roleSpan);
                
                info.appendChild(emailDiv);
                info.appendChild(metaDiv);
                flex.appendChild(info);
                card.appendChild(flex);
                container.appendChild(card);
            });
        }

        function renderAdminSessions(sessions) {
            const container = document.getElementById('adminSessionsList');
            container.replaceChildren();
            
            if (!sessions || sessions.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.style.cssText = 'text-align: center; padding: 1rem; color: #94a3b8;';
                emptyDiv.textContent = 'No active sessions';
                container.appendChild(emptyDiv);
                return;
            }

            sessions.forEach(session => {
                const lastActivity = new Date(session.last_activity).toLocaleString();
                
                const card = document.createElement('div');
                card.style.cssText = 'padding: 0.75rem; margin-bottom: 0.5rem; background: rgba(255, 255, 255, 0.05); border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.1);';
                
                const emailDiv = document.createElement('div');
                emailDiv.style.cssText = 'font-weight: 600; color: white;';
                emailDiv.textContent = session.user_email || session.user_phone;
                
                const locationDiv = document.createElement('div');
                locationDiv.style.cssText = 'font-size: 0.75rem; color: #94a3b8; margin-top: 0.25rem;';
                locationDiv.textContent = '📍 ' + (session.location || 'Unknown');
                
                const deviceDiv = document.createElement('div');
                deviceDiv.style.cssText = 'font-size: 0.75rem; color: #94a3b8;';
                deviceDiv.textContent = '💻 ' + session.device_type + ' • ' + session.browser;
                
                const lastDiv = document.createElement('div');
                lastDiv.style.cssText = 'font-size: 0.75rem; color: #64748b; margin-top: 0.25rem;';
                lastDiv.textContent = 'Last: ' + lastActivity;
                
                card.appendChild(emailDiv);
                card.appendChild(locationDiv);
                card.appendChild(deviceDiv);
                card.appendChild(lastDiv);
                container.appendChild(card);
            });
        }

        function renderAdminAuditLogs(logs) {
            const container = document.getElementById('adminAuditLogs');
            container.replaceChildren();
            
            if (!logs || logs.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.style.cssText = 'text-align: center; padding: 1rem; color: #94a3b8;';
                emptyDiv.textContent = 'No audit logs found';
                container.appendChild(emptyDiv);
                return;
            }

            const actionIcons = {
                'LOGIN': '🔑',
                'LOGOUT': '🚪',
                'SESSION_CREATE': '🔐',
                'SESSION_REVOKE': '🚫',
                'USER_CREATE': '👤',
                'USER_UPDATE': '✏️',
                'USER_DELETE': '🗑️',
                'BOT_CREATE': '🌉',
                'BOT_UPDATE': '⚙️',
                'BOT_DELETE': '❌',
                'PASSWORD_RESET': '🔒',
                'SELF_REGISTER': '📝'
            };

            logs.forEach(log => {
                const timestamp = new Date(log.timestamp).toLocaleString();
                const icon = actionIcons[log.action_type] || '📋';
                
                const card = document.createElement('div');
                card.style.cssText = 'padding: 0.75rem; margin-bottom: 0.5rem; background: rgba(255, 255, 255, 0.03); border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.08); font-size: 0.875rem;';
                
                const flex = document.createElement('div');
                flex.style.cssText = 'display: flex; justify-content: space-between; align-items: start;';
                
                const content = document.createElement('div');
                content.style.flex = '1';
                
                const iconSpan = document.createElement('span');
                iconSpan.style.fontSize = '1.25rem';
                iconSpan.textContent = icon;
                
                const actionStrong = document.createElement('strong');
                actionStrong.style.cssText = 'color: white; margin-left: 0.5rem;';
                actionStrong.textContent = log.action_type;
                
                const actorDiv = document.createElement('div');
                actorDiv.style.cssText = 'color: #94a3b8; margin-top: 0.25rem; margin-left: 2rem;';
                actorDiv.appendChild(document.createTextNode('Actor: '));
                const actorSpan = document.createElement('span');
                actorSpan.style.color = '#60a5fa';
                actorSpan.textContent = log.actor_email || 'System';
                actorDiv.appendChild(actorSpan);
                
                if (log.target_email) {
                    actorDiv.appendChild(document.createTextNode(' → Target: '));
                    const targetSpan = document.createElement('span');
                    targetSpan.style.color = '#f59e0b';
                    targetSpan.textContent = log.target_email;
                    actorDiv.appendChild(targetSpan);
                }
                
                content.appendChild(iconSpan);
                content.appendChild(actionStrong);
                content.appendChild(actorDiv);
                
                if (log.ip_address) {
                    const ipDiv = document.createElement('div');
                    ipDiv.style.cssText = 'color: #64748b; font-size: 0.75rem; margin-top: 0.25rem; margin-left: 2rem;';
                    ipDiv.textContent = 'IP: ' + log.ip_address;
                    content.appendChild(ipDiv);
                }
                
                const timeDiv = document.createElement('div');
                timeDiv.style.cssText = 'text-align: right; color: #64748b; font-size: 0.75rem; white-space: nowrap;';
                timeDiv.textContent = timestamp;
                
                flex.appendChild(content);
                flex.appendChild(timeDiv);
                card.appendChild(flex);
                container.appendChild(card);
            });
        }

        // SCHEMA SWITCHEROO: Global variable to control which webhook source to use
        // 'user' = output_0n (user-facing webhook, Books tab)
        // 'ledger' = output_01 (permanent ledger, Dev Panel)
        let currentViewSource = 'user';
        let isDevPanelView = false;
        
        // Tab Switching
        function switchTab(tabName) {
            // Update tab buttons
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            if (event && event.target) {
                event.target.classList.add('active');
            }
            
            // Update tab content - hide all first (use inline styles for compatibility)
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
                content.style.display = 'none';
            });
            
                // SCHEMA SWITCHEROO: Dev Panel reuses Books tab DOM completely
            if (tabName === 'devPanel') {
                const booksTab = document.getElementById('booksTab');
                if (booksTab) {
                    booksTab.classList.add('active');
                    booksTab.style.display = 'block';
                    
                    // SWITCHEROO: Change header and switch to ledger view (output_01)
                    const header = booksTab.querySelector('.section-header h1');
                    const subtitle = booksTab.querySelector('.section-header .create-bot-btn');
                    if (header) header.textContent = '🔧 Dev Panel - Ledger View (Read-Only)';
                    if (subtitle) subtitle.style.display = 'none'; // Hide Create Book button
                    
                    currentViewSource = 'ledger';
                    isDevPanelView = true;
                    
                    // Load system-wide books for Dev Panel
                    loadDevPanelBooks();
                }
            } else {
                // Find and show the correct tab content
                const tabContent = document.getElementById(`${tabName}Tab`);
                if (tabContent) {
                    tabContent.classList.add('active');
                    tabContent.style.display = 'block';
                    
                    // SWITCHEROO: Reset to user view (output_0n) for regular tabs
                    currentViewSource = 'user';
                    isDevPanelView = false;
                    
                    // Restore Books tab header if switching back
                    if (tabName === 'books') {
                        const header = tabContent.querySelector('.section-header h1');
                        const createBtn = tabContent.querySelector('.section-header .create-bot-btn');
                        if (header) header.textContent = 'Book Library';
                        if (createBtn) createBtn.style.display = 'inline-block'; // Show Create Book button
                    }
                    
                    // Load data for the tab
                    if (tabName === 'books') {
                        loadBooks();
                    } else if (tabName === 'users') {
                        loadAdminCards();
                    } else if (tabName === 'sessions') {
                        loadSessions();
                    } else if (tabName === 'analytics') {
                        loadAnalyticsDashboard();
                    }
                } else {
                    console.error(`Tab content not found for: ${tabName}Tab`);
                }
            }
        }
        
        // Load Users tab (tenant user management for all roles including dev)
        async function loadAdminCards() {
            try {
                const response = await window.authFetch('/api/users');
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const allUsers = await response.json();
                
                // Both dev and admin: Show user management for their own tenant
                renderAdminUserManagement(allUsers);
            } catch (error) {
                console.error('Error loading users tab:', error);
                const container = document.getElementById('adminCards');
                if (container) {
                    container.replaceChildren();
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'padding: 3rem; color: #ef4444;';
                    errorDiv.textContent = 'Error loading users: ' + error.message;
                    container.appendChild(errorDiv);
                }
            }
        }
        
        // Load Dev Panel (system-wide books overview)
        async function loadDevPanelAdmins() {
            console.log('🔧 Loading Dev Panel...');
            
            // Hide admin cards section (requires complex permissions)
            const adminCardsContainer = document.getElementById('devPanelAdminCards');
            if (adminCardsContainer) {
                adminCardsContainer.style.display = 'none';
            }
            
            // Just load system-wide books
            loadDevPanelBooks();
        }
        
        // Render horizontal admin cards in Dev Panel (system overview)
        function renderDevPanelAdminCards(tenants, adminsByTenant) {
            const container = document.getElementById('devPanelAdminCards');
            if (!container) return;
            
            container.replaceChildren();
            
            if (tenants.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.style.cssText = 'padding: 3rem; color: #94a3b8;';
                emptyDiv.textContent = 'No admins found';
                container.appendChild(emptyDiv);
                return;
            }
            
            tenants.forEach((tenant) => {
                const users = adminsByTenant[tenant];
                const genesisAdmin = users.find(u => u.role === 'admin' || u.role === 'dev') || users[0];
                const adminNumber = tenant.replace('tenant_', '').padStart(2, '0');
                const botCount = genesisAdmin.bridge_count || 0;
                const messageCount = genesisAdmin.message_count || 0;
                
                const card = document.createElement('div');
                card.className = 'glass-card';
                card.style.cssText = 'min-width: 300px; flex-shrink: 0; padding: 1.5rem;';
                
                // Header section
                const header = document.createElement('div');
                header.style.cssText = 'display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;';
                
                const avatar = document.createElement('div');
                avatar.style.cssText = 'width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 1.5rem; font-weight: 700; flex-shrink: 0;';
                avatar.textContent = adminNumber;
                
                const info = document.createElement('div');
                info.style.cssText = 'flex: 1; min-width: 0;';
                
                const titleDiv = document.createElement('div');
                titleDiv.style.cssText = 'color: white; font-weight: 600; font-size: 1.125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                titleDiv.textContent = 'Admin #' + adminNumber;
                
                const emailDiv = document.createElement('div');
                emailDiv.style.cssText = 'color: #94a3b8; font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                emailDiv.textContent = genesisAdmin.email;
                
                info.appendChild(titleDiv);
                info.appendChild(emailDiv);
                header.appendChild(avatar);
                header.appendChild(info);
                
                // Stats section
                const stats = document.createElement('div');
                stats.style.cssText = 'display: flex; gap: 1rem; margin-top: 1rem;';
                
                const botStat = document.createElement('div');
                botStat.style.cssText = 'flex: 1; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 0.5rem; padding: 0.75rem; text-align: center;';
                const botNum = document.createElement('div');
                botNum.style.cssText = 'color: #3b82f6; font-size: 1.5rem; font-weight: 700;';
                botNum.textContent = botCount;
                const botLabel = document.createElement('div');
                botLabel.style.cssText = 'color: #94a3b8; font-size: 0.75rem; margin-top: 0.25rem;';
                botLabel.textContent = 'Bots';
                botStat.appendChild(botNum);
                botStat.appendChild(botLabel);
                
                const msgStat = document.createElement('div');
                msgStat.style.cssText = 'flex: 1; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 0.5rem; padding: 0.75rem; text-align: center;';
                const msgNum = document.createElement('div');
                msgNum.style.cssText = 'color: #10b981; font-size: 1.5rem; font-weight: 700;';
                msgNum.textContent = messageCount;
                const msgLabel = document.createElement('div');
                msgLabel.style.cssText = 'color: #94a3b8; font-size: 0.75rem; margin-top: 0.25rem;';
                msgLabel.textContent = 'Messages';
                msgStat.appendChild(msgNum);
                msgStat.appendChild(msgLabel);
                
                stats.appendChild(botStat);
                stats.appendChild(msgStat);
                
                // Footer section
                const footer = document.createElement('div');
                footer.style.cssText = 'margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.1);';
                
                const tenantRow = document.createElement('div');
                tenantRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; color: #94a3b8; font-size: 0.75rem;';
                const homeIcon = document.createElement('span');
                homeIcon.textContent = '🏠';
                const tenantName = document.createElement('span');
                tenantName.textContent = tenant;
                tenantRow.appendChild(homeIcon);
                tenantRow.appendChild(tenantName);
                
                const userRow = document.createElement('div');
                userRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; color: #94a3b8; font-size: 0.75rem; margin-top: 0.25rem;';
                const userIcon = document.createElement('span');
                userIcon.textContent = '👤';
                const userCount = document.createElement('span');
                userCount.textContent = users.length + ' ' + (users.length === 1 ? 'user' : 'users') + ' in tenant';
                userRow.appendChild(userIcon);
                userRow.appendChild(userCount);
                
                footer.appendChild(tenantRow);
                footer.appendChild(userRow);
                
                card.appendChild(header);
                card.appendChild(stats);
                card.appendChild(footer);
                container.appendChild(card);
            });
        }
        
        // Render user management for admins (tenant-specific)
        function renderAdminUserManagement(allUsers) {
            const container = document.getElementById('adminCards');
            if (!container) return;
            
            container.replaceChildren();
            
            // Filter users in this admin's tenant only
            const tenantUsers = allUsers.filter(u => u.tenant_id === currentUser.tenant_id);
            
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'width: 100%; max-width: 800px;';
            
            const card = document.createElement('div');
            card.className = 'glass-card';
            card.style.padding = '1.5rem';
            
            // Header
            const header = document.createElement('div');
            header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;';
            
            const title = document.createElement('h2');
            title.style.cssText = 'font-size: 1.25rem; font-weight: 600; color: white;';
            title.textContent = '👥 Tenant Users';
            
            const inviteBtn = document.createElement('button');
            inviteBtn.className = 'create-bot-btn';
            inviteBtn.dataset.action = 'openCreateUserModal';
            inviteBtn.style.cssText = 'padding: 0.5rem 1rem; font-size: 0.875rem;';
            inviteBtn.textContent = '+ Invite User';
            
            header.appendChild(title);
            header.appendChild(inviteBtn);
            card.appendChild(header);
            
            if (tenantUsers.length === 0) {
                const emptyState = document.createElement('div');
                emptyState.style.cssText = 'text-align: center; padding: 3rem; color: #94a3b8;';
                
                const p1 = document.createElement('p');
                p1.style.marginBottom = '1rem';
                p1.textContent = 'No additional users in your tenant';
                
                const p2 = document.createElement('p');
                p2.style.fontSize = '0.875rem';
                p2.textContent = 'Click "+ Invite User" to add read-only or write-only users';
                
                emptyState.appendChild(p1);
                emptyState.appendChild(p2);
                card.appendChild(emptyState);
            } else {
                const userList = document.createElement('div');
                userList.style.cssText = 'display: flex; flex-direction: column; gap: 0.75rem;';
                
                tenantUsers.forEach(user => {
                    const userItem = document.createElement('div');
                    userItem.className = 'user-item';
                    
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
                    
                    const info = document.createElement('div');
                    info.style.flex = '1';
                    
                    const nameRow = document.createElement('div');
                    nameRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';
                    
                    const emailStrong = document.createElement('strong');
                    emailStrong.style.color = 'white';
                    emailStrong.textContent = user.email;
                    nameRow.appendChild(emailStrong);
                    
                    const roleBadge = document.createElement('span');
                    roleBadge.className = 'stat-badge';
                    roleBadge.style.cssText = 'background: rgba(59, 130, 246, 0.2); color: #3b82f6; font-size: 0.75rem; padding: 0.25rem 0.5rem;';
                    roleBadge.textContent = user.role;
                    nameRow.appendChild(roleBadge);
                    
                    if (user.is_genesis_admin) {
                        const genesisBadge = document.createElement('span');
                        genesisBadge.className = 'stat-badge';
                        genesisBadge.style.cssText = 'background: rgba(251, 191, 36, 0.2); color: #fbbf24; font-size: 0.75rem; padding: 0.25rem 0.5rem;';
                        genesisBadge.textContent = 'Genesis Admin';
                        nameRow.appendChild(genesisBadge);
                    }
                    
                    const dateDiv = document.createElement('div');
                    dateDiv.style.cssText = 'color: #94a3b8; font-size: 0.875rem; margin-top: 0.25rem;';
                    dateDiv.textContent = 'Created: ' + new Date(user.created_at).toLocaleDateString();
                    
                    info.appendChild(nameRow);
                    info.appendChild(dateDiv);
                    row.appendChild(info);
                    
                    if (!user.is_genesis_admin && user.role !== 'admin') {
                        const deleteBtn = document.createElement('button');
                        deleteBtn.className = 'btn-icon btn-danger';
                        deleteBtn.dataset.deleteUser = user.id;
                        deleteBtn.title = 'Remove User';
                        deleteBtn.textContent = '🗑️';
                        row.appendChild(deleteBtn);
                    }
                    
                    userItem.appendChild(row);
                    userList.appendChild(userItem);
                });
                
                card.appendChild(userList);
            }
            
            wrapper.appendChild(card);
            container.appendChild(wrapper);
        }
        
        // Load users for Dev Panel
        async function loadDevPanelUsers() {
            try {
                const response = await window.authFetch('/api/users');
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                setUsers(await response.json());
                renderDevPanelUsers();
            } catch (error) {
                console.error('Error loading dev panel users:', error);
                const userList = document.getElementById('devUserList');
                if (userList) {
                    userList.replaceChildren();
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'text-align: center; padding: 3rem; color: #ef4444;';
                    errorDiv.textContent = 'Error loading users: ' + error.message;
                    userList.appendChild(errorDiv);
                }
            }
        }
        
        // Helper function to get status badge info
        function getStatusBadge(status) {
            const badges = {
                'connected': { emoji: '✅', label: 'Connected', color: 'rgba(34, 197, 94, 0.8)' },
                'inactive': { emoji: '⏸️', label: 'Inactive', color: 'rgba(148, 163, 184, 0.8)' },
                'disconnected': { emoji: '🔌', label: 'Disconnected', color: 'rgba(239, 68, 68, 0.8)' },
                'auth_failed': { emoji: '❌', label: 'Auth Failed', color: 'rgba(239, 68, 68, 0.8)' },
                'error': { emoji: '⚠️', label: 'Error', color: 'rgba(239, 68, 68, 0.8)' }
            };
            return badges[status] || badges['inactive'];
        }
        
        // DEV PANEL: Show book information modal (read-only)
        function showBookInfo(fractalId) {
            const book = bots.find(b => b.fractal_id === fractalId);
            if (!book) return;
            
            const tenantNum = String(book.tenant_id || 1).padStart(2, '0');
            
            let modal = document.getElementById('bookInfoModal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'bookInfoModal';
                modal.className = 'modal';
                document.body.appendChild(modal);
            }
            modal.replaceChildren();
            
            const content = document.createElement('div');
            content.className = 'modal-content';
            content.style.maxWidth = '600px';
            
            const header = document.createElement('div');
            header.className = 'modal-header';
            
            const title = document.createElement('h2');
            title.className = 'modal-title';
            title.textContent = 'ℹ️ Book Information';
            
            const closeBtn = document.createElement('button');
            closeBtn.className = 'close-btn';
            closeBtn.dataset.closeModal = 'bookInfoModal';
            closeBtn.textContent = '×';
            
            header.appendChild(title);
            header.appendChild(closeBtn);
            
            const body = document.createElement('div');
            body.style.padding = '1.5rem';
            
            const details = document.createElement('div');
            details.style.cssText = 'background: rgba(255,255,255,0.03); border-radius: 12px; padding: 1.5rem;';
            
            // Helper to create detail rows
            function addDetailRow(label, value, extraStyle) {
                const row = document.createElement('div');
                row.className = 'detail-row';
                row.style.marginBottom = '1rem';
                
                const labelSpan = document.createElement('span');
                labelSpan.className = 'detail-label';
                labelSpan.textContent = label;
                
                const valueSpan = document.createElement('span');
                valueSpan.className = 'detail-value';
                if (extraStyle) valueSpan.style.cssText = extraStyle;
                valueSpan.textContent = value;
                
                row.appendChild(labelSpan);
                row.appendChild(valueSpan);
                details.appendChild(row);
            }
            
            addDetailRow('Tenant', 'Admin #' + tenantNum + ' (' + (book.tenant_owner_email || 'Unknown') + ')');
            addDetailRow('Fractal ID', book.fractal_id, 'font-family: monospace; font-size: 0.875rem;');
            addDetailRow('Input Platform', book.input_platform || 'whatsapp');
            addDetailRow('Output Platform', book.output_platform || 'discord');
            addDetailRow('Created', new Date(book.created_at).toLocaleString());
            
            if (book.output_0n_url) {
                addDetailRow('User Webhook (Output #0n)', book.output_0n_url, 'font-size: 0.75rem; word-break: break-all; font-family: monospace;');
            }
            
            body.appendChild(details);
            content.appendChild(header);
            content.appendChild(body);
            modal.appendChild(content);
            modal.style.display = 'flex';
        }
        
        function closeModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.style.display = 'none';
        }
        
        // SCHEMA SWITCHEROO: Load system-wide books for Dev Panel, then reuse Books tab rendering
        async function loadDevPanelBooks() {
            try {
                console.log('🔧 Dev Panel: Loading system-wide books...');
                const response = await window.authFetch('/api/dev/books');
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const systemBooks = await response.json();
                console.log(`✅ Dev Panel: Loaded ${systemBooks.length} books across all tenants`);
                
                // REUSE: Store in global bots array (same as Books tab)
                bots = systemBooks;
                
                // REUSE: Call existing book rendering (will use source=ledger automatically)
                renderBooksSidebar();
                
                // Auto-select first book
                if (bots.length > 0 && !selectedBotId) {
                    selectBot(bots[0].fractal_id);
                }
            } catch (error) {
                console.error('❌ Dev Panel: Failed to load books:', error);
                const sidebar = document.getElementById('bookListContainer');
                if (sidebar) {
                    sidebar.replaceChildren();
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'padding: 2rem; color: #ef4444; text-align: center;';
                    errorDiv.textContent = 'Error: ' + error.message;
                    sidebar.appendChild(errorDiv);
                }
            }
        }
        
        // Render Dev Panel books in Discord-style sidebar
        function renderDevPanelBooksSidebar() {
            const sidebar = document.getElementById('devPanelBookSidebar');
            const countEl = document.getElementById('devPanelBookCount');
            
            if (!sidebar) return;
            
            if (countEl) {
                countEl.textContent = devPanelBooks.length;
            }
            
            sidebar.replaceChildren();
            
            if (devPanelBooks.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.style.cssText = 'padding: 2rem; color: #94a3b8; text-align: center;';
                emptyDiv.textContent = 'No books';
                sidebar.appendChild(emptyDiv);
                return;
            }
            
            // Group by tenant
            const byTenant = {};
            devPanelBooks.forEach(book => {
                const tenant = `tenant_${book.tenant_id}`;
                if (!byTenant[tenant]) byTenant[tenant] = [];
                byTenant[tenant].push(book);
            });
            
            Object.keys(byTenant).sort().forEach(tenant => {
                const books = byTenant[tenant];
                const tenantNum = tenant.replace('tenant_', '');
                
                const section = document.createElement('div');
                section.style.marginBottom = '1rem';
                
                const header = document.createElement('div');
                header.style.cssText = 'font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; font-weight: 600; margin-bottom: 0.5rem; padding: 0 0.5rem;';
                header.textContent = 'Tenant ' + tenantNum;
                section.appendChild(header);
                
                books.forEach(book => {
                    const isSelected = book.fractal_id === selectedDevBookId;
                    const statusIcon = getStatusBadge(book.status).emoji;
                    
                    const item = document.createElement('div');
                    item.className = 'channel-item' + (isSelected ? ' active' : '');
                    item.dataset.bookId = book.fractal_id;
                    item.dataset.devBook = book.fractal_id;
                    item.style.cssText = 'padding: 0.75rem; margin: 0.25rem 0; cursor: pointer; border-radius: 8px; background: ' + (isSelected ? 'rgba(255,255,255,0.1)' : 'transparent') + '; transition: all 0.2s;';
                    
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';
                    
                    const iconSpan = document.createElement('span');
                    iconSpan.style.fontSize = '1rem';
                    iconSpan.textContent = statusIcon;
                    
                    const nameSpan = document.createElement('span');
                    nameSpan.style.cssText = 'color: ' + (isSelected ? 'white' : '#cbd5e1') + '; font-weight: ' + (isSelected ? '600' : '400') + '; font-size: 0.875rem;';
                    nameSpan.textContent = book.name || book.input_platform + ' → ' + book.output_platform;
                    
                    row.appendChild(iconSpan);
                    row.appendChild(nameSpan);
                    item.appendChild(row);
                    section.appendChild(item);
                });
                
                sidebar.appendChild(section);
            });
        }
        
        // Select and display dev book details
        function selectDevBook(fractalId) {
            selectedDevBookId = fractalId;
            const book = devPanelBooks.find(b => b.fractal_id === fractalId);
            if (book) {
                renderDevPanelBooksSidebar(); // Re-render to update selection
                renderDevPanelBookDetail(book);
            }
        }
        
        // Render book detail view
        function renderDevPanelBookDetail(book) {
            const detail = document.getElementById('devPanelBookDetail');
            if (!detail) return;
            
            detail.replaceChildren();
            
            const statusBadge = getStatusBadge(book.status);
            const tenantNum = String(book.tenant_id).padStart(2, '0');
            
            const wrapper = document.createElement('div');
            wrapper.style.marginBottom = '1.5rem';
            
            // Header row
            const headerRow = document.createElement('div');
            headerRow.style.cssText = 'display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;';
            
            const title = document.createElement('h2');
            title.style.cssText = 'color: white; font-size: 1.5rem; font-weight: 700; margin: 0;';
            title.textContent = book.name || book.input_platform + ' → ' + book.output_platform;
            
            const badge = document.createElement('span');
            badge.style.cssText = 'background: ' + statusBadge.color + '; color: white; padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600;';
            badge.textContent = statusBadge.emoji + ' ' + statusBadge.label;
            
            headerRow.appendChild(title);
            headerRow.appendChild(badge);
            wrapper.appendChild(headerRow);
            
            // Details grid
            const grid = document.createElement('div');
            grid.style.cssText = 'display: grid; gap: 1rem;';
            
            function addRow(label, value, extraStyle) {
                const row = document.createElement('div');
                row.className = 'detail-row';
                
                const labelSpan = document.createElement('span');
                labelSpan.className = 'detail-label';
                labelSpan.textContent = label;
                
                const valueSpan = document.createElement('span');
                valueSpan.className = 'detail-value';
                if (extraStyle) valueSpan.style.cssText = extraStyle;
                valueSpan.textContent = value;
                
                row.appendChild(labelSpan);
                row.appendChild(valueSpan);
                grid.appendChild(row);
            }
            
            addRow('Tenant', 'Admin #' + tenantNum + ' (' + book.tenant_owner_email + ')');
            addRow('Fractal ID', book.fractal_id, 'font-family: monospace; font-size: 0.875rem;');
            addRow('Input Platform', book.input_platform);
            addRow('Output Platform', book.output_platform);
            
            if (book.contact_info) {
                addRow('Contact Info', book.contact_info);
            }
            
            addRow('Created', new Date(book.created_at).toLocaleString());
            
            if (book.output_0n_url) {
                addRow('User Webhook (Output #0n)', book.output_0n_url, 'font-size: 0.875rem; word-break: break-all;');
            }
            
            wrapper.appendChild(grid);
            detail.appendChild(wrapper);
        }
        
        function renderDevPanelUsers() {
            const userList = document.getElementById('devUserList');
            if (!userList) return;
            
            userList.replaceChildren();
            
            if (!users || users.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.style.cssText = 'text-align: center; padding: 3rem; color: #94a3b8;';
                emptyDiv.textContent = 'No users found';
                userList.appendChild(emptyDiv);
                return;
            }
            
            users.forEach(user => {
                const item = document.createElement('div');
                item.className = 'user-item';
                
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
                
                const info = document.createElement('div');
                info.style.flex = '1';
                
                const nameRow = document.createElement('div');
                nameRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';
                
                const emailStrong = document.createElement('strong');
                emailStrong.style.color = 'white';
                emailStrong.textContent = user.email;
                
                const roleBadge = document.createElement('span');
                roleBadge.className = 'stat-badge';
                roleBadge.style.cssText = 'background: rgba(59, 130, 246, 0.2); color: #3b82f6; font-size: 0.75rem; padding: 0.25rem 0.5rem;';
                roleBadge.textContent = user.role;
                
                const schemaBadge = document.createElement('span');
                schemaBadge.className = 'stat-badge';
                schemaBadge.style.cssText = 'font-size: 0.75rem; padding: 0.25rem 0.5rem;';
                schemaBadge.textContent = user.tenant_schema || 'public';
                
                nameRow.appendChild(emailStrong);
                nameRow.appendChild(roleBadge);
                nameRow.appendChild(schemaBadge);
                
                const dateDiv = document.createElement('div');
                dateDiv.style.cssText = 'color: #94a3b8; font-size: 0.875rem; margin-top: 0.25rem;';
                dateDiv.textContent = 'Created: ' + new Date(user.created_at).toLocaleDateString();
                
                info.appendChild(nameRow);
                info.appendChild(dateDiv);
                row.appendChild(info);
                
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'btn-icon btn-danger';
                deleteBtn.dataset.deleteUser = user.id;
                deleteBtn.title = 'Delete User';
                deleteBtn.textContent = '🗑️';
                row.appendChild(deleteBtn);
                
                item.appendChild(row);
                userList.appendChild(item);
            });
        }

        // Cat animation now isolated in /js/ui/cat-animation.js (GLOBAL CONSTANT #2)

        // Handle OAuth callback tokens from URL
        function handleOAuthCallback() {
            const urlParams = new URLSearchParams(window.location.search);
            const accessToken = urlParams.get('accessToken');
            const refreshToken = urlParams.get('refreshToken');
            
            if (accessToken && refreshToken) {
                // Save tokens to localStorage
                localStorage.setItem('accessToken', accessToken);
                localStorage.setItem('refreshToken', refreshToken);
                
                // Clean URL by removing query parameters
                window.history.replaceState({}, document.title, window.location.pathname);
                
                console.log('✅ OAuth login successful - tokens saved');
            }
        }

        handleOAuthCallback();
        _showBookSkeletons();
        checkAuth().then(authenticated => {
            if (!authenticated) return;
            initHopAnimation();
            _buildDetailShell();
            _initPriorityLoad();
            _initBackgroundBooks();
        });
        // ===== SYSTEM STATUS BAR =====
        let startTime = Date.now();
        let lastUpdateSecond = -1;
        
        function updateSystemStatus() {
            const now = Date.now();
            const currentSecond = Math.floor(now / 1000);
            
            // Only update when second actually changes (prevents drift)
            if (currentSecond === lastUpdateSecond) return;
            lastUpdateSecond = currentSecond;
            
            // Update uptime
            const uptime = now - startTime;
            const hours = Math.floor(uptime / 3600000);
            const minutes = Math.floor((uptime % 3600000) / 60000);
            
            // Update uptime in compact indicators only
            const uptimeEl = document.getElementById('systemUptimeCompact');
            if (uptimeEl) uptimeEl.textContent = `${hours}h ${minutes}m`;
            
            // Update current time (both default and compact displays)
            const date = new Date();
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const timeHours = date.getHours();
            const timeMinutes = String(date.getMinutes()).padStart(2, '0');
            const timeSeconds = String(date.getSeconds()).padStart(2, '0');
            const ampm = timeHours >= 12 ? 'PM' : 'AM';
            const displayHours = timeHours % 12 || 12;
            
            // Default view: Two-line format (below cat)
            const currentTimeEl = document.getElementById('currentTime');
            if (currentTimeEl) {
                currentTimeEl.replaceChildren();
                currentTimeEl.appendChild(document.createTextNode(`${year}/${month}/${day}`));
                currentTimeEl.appendChild(document.createElement('br'));
                currentTimeEl.appendChild(document.createTextNode(`${displayHours}:${timeMinutes}:${timeSeconds}${ampm}`));
            }
            
            // Compact view: Single-line with dash separator (before user info)
            const currentTimeCompactEl = document.getElementById('currentTimeCompact');
            if (currentTimeCompactEl) {
                currentTimeCompactEl.replaceChildren();
                currentTimeCompactEl.appendChild(document.createTextNode(`${year}/${month}/${day}`));
                currentTimeCompactEl.appendChild(document.createElement('br'));
                currentTimeCompactEl.appendChild(document.createTextNode(`${displayHours}:${timeMinutes}:${timeSeconds}${ampm}`));
            }
            
            // Update book count in compact indicators only
            const bookCountEl = document.getElementById('bookCountCompact');
            if (bookCountEl) bookCountEl.textContent = books.length;
            
            // Update active sessions in compact indicators only
            if (window.sessions) {
                const activeCount = sessions.filter(s => s.is_active).length;
                const activeSessionsEl = document.getElementById('activeSessionsCompact');
                if (activeSessionsEl) activeSessionsEl.textContent = activeCount;
            }
        }
        
        // Update via RAF for smooth, drift-free timing (piggyback on cat animation loop)
        let statusRafId = null;
        function updateStatusLoop() {
            updateSystemStatus();
            statusRafId = requestAnimationFrame(updateStatusLoop);
        }
        updateStatusLoop();
        updateSystemStatus();
        
        // ===== COMPACT MODE TOGGLE =====
        function toggleCompactMode() {
            document.body.classList.toggle('compact-mode');
            const isCompact = document.body.classList.contains('compact-mode');
            document.getElementById('compactModeText').textContent = isCompact ? 'Normal' : 'Compact';
            document.getElementById('compactModeIcon').textContent = isCompact ? '📏' : '📐';
            localStorage.setItem('compactMode', isCompact);
        }
        
        // Restore compact mode from localStorage
        if (localStorage.getItem('compactMode') === 'true') {
            document.body.classList.add('compact-mode');
            document.getElementById('compactModeText').textContent = 'Normal';
            document.getElementById('compactModeIcon').textContent = '📏';
        }
        
        // ===== ONBOARDING HINTS =====
        const hints = {
            'createBook': {
                element: '.create-bot-btn',
                text: 'Click here to initiate your Nyanbook~',
                shown: false
            },
            'searchMessages': {
                element: '.discord-search-input',
                text: 'Search through all messages in this book',
                shown: false
            },
            'analytics': {
                element: 'button.tab:last-child',
                text: 'View message analytics and success rates',
                shown: false
            }
        };
        
        function showOnboardingHint(hintKey) {
            const hint = hints[hintKey];
            if (!hint || hint.shown || localStorage.getItem(`hint_${hintKey}`)) return;
            
            const targetEl = document.querySelector(hint.element);
            if (!targetEl) return;
            
            const hintEl = document.createElement('div');
            hintEl.className = 'onboarding-hint';
            hintEl.appendChild(document.createTextNode(hint.text + ' '));
            const closeBtn = document.createElement('button');
            closeBtn.className = 'close-hint';
            closeBtn.dataset.dismissHint = hintKey;
            closeBtn.textContent = '×';
            hintEl.appendChild(closeBtn);
            
            const rect = targetEl.getBoundingClientRect();
            hintEl.style.top = `${rect.bottom + 12}px`;
            hintEl.style.left = `${rect.left}px`;
            
            document.body.appendChild(hintEl);
            hint.shown = true;
            
            setTimeout(() => {
                if (hintEl.parentNode) hintEl.remove();
            }, 8000);
        }
        
        function dismissHint(hintKey, button) {
            localStorage.setItem(`hint_${hintKey}`, 'dismissed');
            button.parentElement.remove();
        }
        
        // Show hints after page loads
        setTimeout(() => {
            if (books.length === 0) {
                showOnboardingHint('createBook');
            }
        }, 2000);
        
        setTimeout(() => {
            showOnboardingHint('analytics');
        }, 5000);

// ===== EVENT LISTENER BINDINGS (CSP-Safe) =====
// All event handlers bound here instead of inline onclick/onsubmit attributes
document.addEventListener('DOMContentLoaded', function() {
    // Initialize mobile detection and mode switching
    initMobileDetection();
    
    // Initialize touch interactions (tap-to-zoom, swipe navigation)
    initTouchInteractions();
    
    // UNIFIED: Thumbs zone + desktop button event delegation (CSP-compliant)
    document.addEventListener('click', function(e) {
        const thumbBtn = e.target.closest('.thumb-btn, .thumbs-zone button');
        const createBtn = e.target.closest('.create-bot-btn');
        const auditBtn = e.target.closest('.audit-type-btn');
        const logoutBtn = e.target.closest('.logout-btn');
        const aiBtn = e.target.closest('#aiPlaygroundBtn');
        
        // AI Playground button
        if (aiBtn) {
            window.location.href = '/AI';
            return;
        }
        
        // Logout button (desktop header & mobile)
        if (logoutBtn) {
            logout();
            return;
        }
        
        // Mobile thumbs zone
        if (thumbBtn) {
            const action = thumbBtn.dataset.action;
            const bookId = thumbBtn.dataset.bookId;
            
            // ☯️ SINGULARITY BUTTON - Toggle expand/collapse (mobile & desktop)
            if (action === 'singularity') {
                console.log('🌌 Singularity clicked');
                toggleExpand();
                return;
            }
            
            // Registry-based actions (create, audit, search)
            if (ACTION_REGISTRY[action]) {
                executeAction(action);
                return;
            }
            
            // Custom actions (toggle-book, book-actions, fan, next)
            if (action === 'toggle-book' && bookId) {
                selectBook(bookId);
            } else if (action === 'book-actions') {
                showBookActionsMenu();
            } else if (action === 'fan') {
                showBookFanModal();
            } else if (action === 'next') {
                // Next book navigation
                const activeBooks = filteredBooks.length > 0 ? filteredBooks : books;
                if (activeBooks.length <= 1) return;
                
                const currentBookId = document.querySelector('.discord-messages-container')?.id?.replace('discord-messages-', '');
                const currentIndex = activeBooks.findIndex(b => b.fractal_id === currentBookId);
                
                if (currentIndex !== -1) {
                    const nextIndex = currentIndex < activeBooks.length - 1 ? currentIndex + 1 : 0;
                    const nextBook = activeBooks[nextIndex];
                    if (nextBook) {
                        selectBook(nextBook.fractal_id);
                        showToast(`→ ${nextBook.name}`, 'info');
                    }
                }
            }
            return;
        }
        
        // Desktop sidebar buttons (same actions, different triggers)
        if (createBtn) {
            executeAction('create');
            return;
        }
        
        if (auditBtn) {
            executeAction('audit');
            return;
        }
        
        // Copy code button (CSP-compliant replacement for inline onclick)
        const copyBtn = e.target.closest('.copy-code-btn');
        if (copyBtn && copyBtn.dataset.copyText) {
            navigator.clipboard.writeText(copyBtn.dataset.copyText).then(() => {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = '✅ Copied!';
                setTimeout(() => copyBtn.textContent = originalText, 1500);
            }).catch(err => {
                console.error('Copy failed:', err);
                showToast('Failed to copy', 'error');
            });
            return;
        }
    });
    
    // Modal close buttons and backdrop clicks
    const mediaModal = document.getElementById('mediaModal');
    if (mediaModal) {
        mediaModal.addEventListener('click', function(e) {
            if (e.target === this) closeMediaModal();
        });
        const mediaModalClose = mediaModal.querySelector('.media-modal-close');
        if (mediaModalClose) mediaModalClose.addEventListener('click', closeMediaModal);
    }
    
    const createBookModal = document.getElementById('createBookModal');
    if (createBookModal) {
        createBookModal.addEventListener('click', function(e) {
            if (e.target === this) closeCreateBookModal();
        });
        const bookModalClose = createBookModal.querySelector('.book-modal-close');
        if (bookModalClose) bookModalClose.addEventListener('click', closeCreateBookModal);
    }
    
    const botModal = document.getElementById('botModal');
    if (botModal) {
        const botModalClose = botModal.querySelector('.close-btn');
        if (botModalClose) botModalClose.addEventListener('click', closeBotModal);
        const botModalCancel = botModal.querySelector('.cancel-modal-btn');
        if (botModalCancel) botModalCancel.addEventListener('click', closeBotModal);
    }
    
    const userModal = document.getElementById('userModal');
    if (userModal) {
        const userModalClose = userModal.querySelector('.close-btn');
        if (userModalClose) userModalClose.addEventListener('click', closeUserModal);
    }
    
    const changeEmailModal = document.getElementById('changeEmailModal');
    if (changeEmailModal) {
        const emailModalClose = changeEmailModal.querySelector('.close-btn');
        if (emailModalClose) emailModalClose.addEventListener('click', closeChangeEmailModal);
    }
    
    const changePasswordModal = document.getElementById('changePasswordModal');
    if (changePasswordModal) {
        const passwordModalClose = changePasswordModal.querySelector('.close-btn');
        if (passwordModalClose) passwordModalClose.addEventListener('click', closeChangePasswordModal);
    }
    
    const quickStartWizard = document.getElementById('quickStartWizard');
    if (quickStartWizard) {
        const wizardClose = quickStartWizard.querySelector('.close-btn');
        if (wizardClose) wizardClose.addEventListener('click', closeQuickStartWizard);
    }
    
    const onboardingWizard = document.getElementById('onboardingWizard');
    if (onboardingWizard) {
        const onboardingClose = onboardingWizard.querySelector('.close-btn');
        if (onboardingClose) onboardingClose.addEventListener('click', closeOnboardingWizard);
    }
    
    const advancedSearchModal = document.getElementById('advancedSearchModal');
    if (advancedSearchModal) {
        const searchModalClose = advancedSearchModal.querySelector('.close-btn');
        if (searchModalClose) searchModalClose.addEventListener('click', closeAdvancedSearch);
    }
    
    // Form submissions
    const botForm = document.getElementById('botForm');
    if (botForm) botForm.addEventListener('submit', saveBotClicked);
    
    const userForm = document.getElementById('userForm');
    if (userForm) userForm.addEventListener('submit', saveUser);
    
    const changeEmailForm = document.getElementById('changeEmailForm');
    if (changeEmailForm) changeEmailForm.addEventListener('submit', saveNewEmail);
    
    const bookCreateForm = document.getElementById('book-create-form');
    if (bookCreateForm) bookCreateForm.addEventListener('submit', function(e) {
        e.preventDefault();
        // Book creation logic is already in dashboard.js
    });
    
    // Button clicks
    const createBotBtn = document.querySelector('.create-bot-btn');
    if (createBotBtn) createBotBtn.addEventListener('click', openCreatePopup);
    
    const auditTypeBtn = document.querySelector('.audit-type-btn');
    if (auditTypeBtn) auditTypeBtn.addEventListener('click', showNyanAuditModal);
    
    const auditHistoryBtn = document.querySelector('.audit-history-btn');
    if (auditHistoryBtn) auditHistoryBtn.addEventListener('click', showNyanAuditHistoryModal);
    
    const revokeAllBtn = document.querySelector('[onclick*="revokeAllSessions"]');
    if (revokeAllBtn) {
        revokeAllBtn.removeAttribute('onclick');
        revokeAllBtn.addEventListener('click', revokeAllSessions);
    }
    
    // Copy join code button (2-message flow)
    const copyJoinCodeBtn = document.getElementById('copy-join-code-btn');
    if (copyJoinCodeBtn) {
        copyJoinCodeBtn.addEventListener('click', function() {
            const joinCode = document.getElementById('book-join-code').textContent;
            if (joinCode) {
                navigator.clipboard.writeText(joinCode).then(() => {
                    const btn = this;
                    const originalText = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    btn.style.background = 'rgba(34, 197, 94, 0.2)';
                    btn.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                    btn.style.color = '#22c55e';
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.style.background = '';
                        btn.style.borderColor = '';
                        btn.style.color = '';
                    }, 1500);
                }).catch(err => {
                    alert('Failed to copy: ' + err.message);
                });
            }
        });
    }
    
    // Copy LINE join code button
    const copyLineCodeBtn = document.getElementById('copy-line-code-btn');
    if (copyLineCodeBtn) {
        copyLineCodeBtn.addEventListener('click', function() {
            const joinCode = document.getElementById('line-join-code').textContent;
            if (joinCode) {
                navigator.clipboard.writeText(joinCode).then(() => {
                    const btn = this;
                    const originalText = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    btn.style.background = 'rgba(34, 197, 94, 0.2)';
                    btn.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                    btn.style.color = '#22c55e';
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.style.background = '';
                        btn.style.borderColor = '';
                        btn.style.color = '';
                    }, 1500);
                }).catch(err => {
                    alert('Failed to copy: ' + err.message);
                });
            }
        });
    }

    // Copy sandbox code button (Step 1: join baby-ability)
    const copySandboxCodeBtn = document.getElementById('copy-sandbox-code-btn');
    if (copySandboxCodeBtn) {
        copySandboxCodeBtn.addEventListener('click', function() {
            const sandboxCode = 'join baby-ability';
            const btn = this;
            const originalText = btn.textContent;
            
            // Try modern clipboard API first, fallback to execCommand for compatibility
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(sandboxCode).then(() => {
                    btn.textContent = '✓ Copied!';
                    btn.style.background = 'rgba(34, 197, 94, 0.2)';
                    btn.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                    btn.style.color = '#22c55e';
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.style.background = '';
                        btn.style.borderColor = '';
                        btn.style.color = '';
                    }, 1500);
                }).catch(err => {
                    console.error('Clipboard API failed:', err);
                    fallbackCopyToClipboard(sandboxCode, btn, originalText);
                });
            } else {
                // Fallback for HTTP and mobile webviews
                fallbackCopyToClipboard(sandboxCode, btn, originalText);
            }
        });
    }
    
    // Fallback copy function using textarea + execCommand
    // iOS Safari and Android webviews require focus + setSelectionRange
    function fallbackCopyToClipboard(text, btn, originalText) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '0';
        textarea.style.width = '1px';
        textarea.style.height = '1px';
        textarea.style.padding = '0';
        textarea.style.border = 'none';
        textarea.style.outline = 'none';
        textarea.style.boxShadow = 'none';
        textarea.style.background = 'transparent';
        document.body.appendChild(textarea);
        
        // Critical for iOS Safari: focus before select
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        
        try {
            const successful = document.execCommand('copy');
            if (successful) {
                btn.textContent = '✓ Copied!';
                btn.style.background = 'rgba(34, 197, 94, 0.2)';
                btn.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                btn.style.color = '#22c55e';
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.style.background = '';
                    btn.style.borderColor = '';
                    btn.style.color = '';
                }, 1500);
            } else {
                alert('Failed to copy text. Please copy manually: ' + text);
            }
        } catch (err) {
            console.error('Fallback copy failed:', err);
            alert('Failed to copy text. Please copy manually: ' + text);
        } finally {
            document.body.removeChild(textarea);
        }
    }
    
    // Search and filter inputs
    const searchBox = document.getElementById('searchBox');
    if (searchBox) searchBox.addEventListener('input', debouncedFilterBots);
    
    const sessionLocationFilter = document.getElementById('sessionLocationFilter');
    if (sessionLocationFilter) sessionLocationFilter.addEventListener('input', loadSessions);
    
    const sessionDeviceFilter = document.getElementById('sessionDeviceFilter');
    if (sessionDeviceFilter) sessionDeviceFilter.addEventListener('change', loadSessions);
    
    const sessionBrowserFilter = document.getElementById('sessionBrowserFilter');
    if (sessionBrowserFilter) sessionBrowserFilter.addEventListener('change', loadSessions);
    
    const sessionSortBy = document.getElementById('sessionSortBy');
    if (sessionSortBy) sessionSortBy.addEventListener('change', loadSessions);
    
    const sessionSortOrder = document.getElementById('sessionSortOrder');
    if (sessionSortOrder) sessionSortOrder.addEventListener('change', loadSessions);
    
    const analyticsBookFilter = document.getElementById('analyticsBookFilter');
    if (analyticsBookFilter) analyticsBookFilter.addEventListener('change', loadAnalyticsDashboard);
    
    const analyticsTimeRange = document.getElementById('analyticsTimeRange');
    if (analyticsTimeRange) analyticsTimeRange.addEventListener('change', loadAnalyticsDashboard);
    
    // Tag input
    const botTagsInput = document.getElementById('botTagsInput');
    if (botTagsInput) botTagsInput.addEventListener('keypress', addTagOnEnter);
    
    // Wizard buttons
    const skipQuickStartBtn = document.querySelector('[onclick*="skipQuickStart"]');
    if (skipQuickStartBtn) {
        skipQuickStartBtn.removeAttribute('onclick');
        skipQuickStartBtn.addEventListener('click', skipQuickStart);
    }
    
    const startBookSetupBtn = document.querySelector('[onclick*="startBookSetup"]');
    if (startBookSetupBtn) {
        startBookSetupBtn.removeAttribute('onclick');
        startBookSetupBtn.addEventListener('click', startBookSetup);
    }
    
    const addWebhookBtn = document.getElementById('addWebhookBtn');
    if (addWebhookBtn) {
        addWebhookBtn.addEventListener('click', addWebhookInput);
    }
    
    // Outpipe buttons
    document.querySelectorAll('.add-outpipe-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.outpipeType || 'webhook';
            userOutpipes.push({ type, name: '', url: '', to: '' });
            renderOutpipes();
        });
    });
    const saveOutpipesBtn = document.getElementById('saveOutpipesBtn');
    if (saveOutpipesBtn) {
        saveOutpipesBtn.addEventListener('click', saveOutpipes);
    }

    // Book code copy button
    const copyBookCodeBtn = document.getElementById('copyBookCodeBtn');
    if (copyBookCodeBtn) {
        copyBookCodeBtn.addEventListener('click', () => {
            const code = document.getElementById('bookCodeDisplay')?.value;
            if (code) {
                navigator.clipboard.writeText(code).then(() => {
                    const orig = copyBookCodeBtn.textContent;
                    copyBookCodeBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBookCodeBtn.textContent = orig; }, 1500);
                });
            }
        });
    }

    // Share book button handler
    const shareBookBtn = document.getElementById('shareBookBtn');
    if (shareBookBtn) {
        shareBookBtn.addEventListener('click', () => {
            const email = document.getElementById('shareEmailInput')?.value?.trim();
            if (editingBookId && email) {
                shareBook(editingBookId, email);
            }
        });
    }
    
    // Share email input - enter key handler
    const shareEmailInput = document.getElementById('shareEmailInput');
    if (shareEmailInput) {
        shareEmailInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const email = shareEmailInput.value?.trim();
                if (editingBookId && email) {
                    shareBook(editingBookId, email);
                }
            }
        });
    }
    
    const copyFractalIdBtn = document.querySelector('[onclick*="copyBookFractalId"]');
    if (copyFractalIdBtn) {
        copyFractalIdBtn.removeAttribute('onclick');
        copyFractalIdBtn.addEventListener('click', copyBookFractalId);
    }
    
    const advancedSearchBtn = document.querySelector('[onclick*="executeAdvancedSearch"]');
    if (advancedSearchBtn) {
        advancedSearchBtn.removeAttribute('onclick');
        advancedSearchBtn.addEventListener('click', executeAdvancedSearch);
    }
    
    // Onboarding platform selection
    const platformOptions = document.querySelectorAll('[onclick*="selectOnboardingPlatform"]');
    platformOptions.forEach(option => {
        const platform = option.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
        if (platform) {
            option.removeAttribute('onclick');
            option.addEventListener('click', () => selectOnboardingPlatform(platform));
        }
    });
    
    // Onboarding wizard step buttons
    const step1NextBtn = document.getElementById('step1-next');
    if (step1NextBtn) {
        step1NextBtn.removeAttribute('onclick');
        step1NextBtn.addEventListener('click', onboardingStep1Next);
    }
    
    const step2NextBtn = document.querySelector('[onclick*="onboardingStep2Next"]');
    if (step2NextBtn) {
        step2NextBtn.removeAttribute('onclick');
        step2NextBtn.addEventListener('click', onboardingStep2Next);
    }
    
    const step3CompleteBtn = document.querySelector('[onclick*="onboardingStep3Complete"]');
    if (step3CompleteBtn) {
        step3CompleteBtn.removeAttribute('onclick');
        step3CompleteBtn.addEventListener('click', onboardingStep3Complete);
    }
    
    // Per-message export: Handle checkbox changes with event delegation
    document.addEventListener('change', function(e) {
        // Individual message checkbox (Discord style)
        if (e.target.classList.contains('message-export-checkbox') || e.target.classList.contains('message-checkbox')) {
            console.log('📋 Checkbox clicked! Element:', e.target);
            console.log('📋 Classes:', e.target.className);
            console.log('📋 Datasets:', e.target.dataset);
            
            const msgId = e.target.dataset.messageId || e.target.dataset.msgId;
            const bookId = e.target.dataset.bookId;
            
            console.log('📋 Extracted msgId:', msgId);
            console.log('📋 Extracted bookId:', bookId);
            
            if (!msgId || !bookId) {
                console.warn('⚠️ Missing msgId or bookId:', { msgId, bookId, element: e.target });
                return;
            }
            
            if (!selectedMessages[bookId]) {
                selectedMessages[bookId] = new Set();
            }
            
            if (e.target.checked) {
                selectedMessages[bookId].add(msgId);
                console.log(`✓ Selected message ${msgId} in book ${bookId} (total: ${selectedMessages[bookId].size})`);
            } else {
                selectedMessages[bookId].delete(msgId);
                console.log(`✗ Deselected message ${msgId} in book ${bookId} (total: ${selectedMessages[bookId].size})`);
            }
            
            console.log('📋 Calling updateBulkActionButtons for book:', bookId);
            updateBulkActionButtons(bookId);
        }
        
        // Select all checkbox
        if (e.target.id && e.target.id.startsWith('select-all-')) {
            const bookId = e.target.id.replace('select-all-', '');
            const checkboxes = document.querySelectorAll(`.message-export-checkbox[data-book-id="${bookId}"], .message-checkbox[data-book-id="${bookId}"]`);
            
            console.log(`Select all for book ${bookId}: found ${checkboxes.length} checkboxes`);
            
            if (!selectedMessages[bookId]) {
                selectedMessages[bookId] = new Set();
            }
            
            if (e.target.checked) {
                checkboxes.forEach(cb => {
                    cb.checked = true;
                    const msgId = cb.dataset.messageId || cb.dataset.msgId;
                    if (msgId) {
                        selectedMessages[bookId].add(msgId);
                    }
                });
                console.log(`✓ Selected ${checkboxes.length} messages in book ${bookId}`);
            } else {
                checkboxes.forEach(cb => {
                    cb.checked = false;
                });
                selectedMessages[bookId].clear();
                console.log(`✗ Cleared all selections in book ${bookId}`);
            }
            
            updateBulkActionButtons(bookId);
        }
    });
});

// ============ DROPS API - Personal Cloud OS ============
// Uses unified window.authFetch for automatic token refresh + retry

// Save a drop (link metadata to Discord message) - APPENDS to existing tags
async function saveDrop(bookId, messageId, metadataText, section) {
    try {
        console.log('💾 Saving drop:', { bookId, messageId, metadataText });
        
        const response = await window.authFetch('/api/drops', {
            method: 'POST',
            body: JSON.stringify({
                book_id: bookId,
                discord_message_id: messageId,
                metadata_text: metadataText
            })
        });
        
        console.log('📡 Response status:', response.status, response.statusText);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('❌ Save failed:', errorData);
            throw new Error(errorData.error || 'Failed to save drop');
        }
        
        const data = await response.json();
        console.log('✅ Drop saved successfully:', data);
        
        // Display the drop (will show all tags as bubbles) - pass fractal_id
        if (section && data.drop) {
            displayDrop(section, data.drop, data.extracted, bookId);
        }
        
    } catch (error) {
        console.error('❌ Error saving drop:', error);
        alert('Failed to save metadata: ' + (error.message || 'Please try again.'));
    }
}

// Remove a specific tag from a message's drop
async function removeTag(bookId, messageId, tag) {
    try {
        console.log('🗑️ Removing tag:', { bookId, messageId, tag });
        
        const response = await window.authFetch('/api/drops/tag', {
            method: 'DELETE',
            body: JSON.stringify({
                book_id: bookId,
                discord_message_id: messageId,
                tag: tag
            })
        });
        
        console.log('🔍 Response status:', response.status, response.statusText);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('❌ Delete failed:', errorData);
            throw new Error(errorData.error || 'Failed to remove tag');
        }
        
        const data = await response.json();
        
        // Re-display the drop with updated tags - MUST pass fractal_id
        const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"][data-book-id="${bookId}"]`);
        if (section && data.drop) {
            displayDrop(section, data.drop, null, bookId);
        }
        
    } catch (error) {
        console.error('Error removing tag:', error);
        alert('Failed to remove tag. Please try again.');
    }
}

// Remove a specific date from a message's drop
async function removeDate(bookId, messageId, date) {
    try {
        console.log('🗑️ Removing date:', { bookId, messageId, date });
        
        const response = await window.authFetch('/api/drops/date', {
            method: 'DELETE',
            body: JSON.stringify({
                book_id: bookId,
                discord_message_id: messageId,
                date: date
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('❌ Delete failed:', errorData);
            throw new Error(errorData.error || 'Failed to remove date');
        }
        
        const data = await response.json();
        
        // Re-display the drop with updated dates
        const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"][data-book-id="${bookId}"]`);
        if (section && data.drop) {
            displayDrop(section, data.drop, null, bookId);
        }
        
    } catch (error) {
        console.error('Error removing date:', error);
        alert('Failed to remove date. Please try again.');
    }
}

// Fetch all drops for a book
async function fetchDrops(bookId) {
    try {
        const response = await window.authFetch(`/api/drops/${bookId}`);
        
        if (!response.ok) {
            throw new Error('Failed to fetch drops');
        }
        
        const data = await response.json();
        return data.drops || [];
    } catch (error) {
        console.error('Error fetching drops:', error);
        return [];
    }
}

// Display a drop in the UI with bubble tags (click to delete)
function displayDrop(section, drop, extracted, fractalBookId) {
    const display = section.querySelector('.drop-display');
    if (!display) return;
    
    // Get fractal_id from section if not provided
    const bookFractalId = fractalBookId || section.getAttribute('data-book-id');
    
    // Handle both formats: extracted object (from POST response) or direct arrays (from GET response)
    const tags = extracted?.tags || drop.extracted_tags || [];
    const dates = extracted?.dates || drop.extracted_dates || [];
    
    display.replaceChildren();
    
    // Tag bubbles with × delete button (use fractal_id, NOT internal book_id)
    if (tags.length > 0) {
        const tagsDiv = document.createElement('div');
        tagsDiv.className = 'drop-tags';
        tags.forEach(tag => {
            const tagSpan = document.createElement('span');
            tagSpan.className = 'drop-tag';
            tagSpan.appendChild(document.createTextNode(tag + ' '));
            const deleteSpan = document.createElement('span');
            deleteSpan.className = 'drop-tag-delete';
            deleteSpan.dataset.action = 'remove-tag';
            deleteSpan.dataset.tag = tag;
            deleteSpan.dataset.messageId = drop.discord_message_id;
            deleteSpan.dataset.bookId = bookFractalId;
            deleteSpan.textContent = '×';
            tagSpan.appendChild(deleteSpan);
            tagsDiv.appendChild(tagSpan);
        });
        display.appendChild(tagsDiv);
    }
    
    if (dates.length > 0) {
        const datesDiv = document.createElement('div');
        datesDiv.className = 'drop-dates';
        dates.forEach(date => {
            const dateSpan = document.createElement('span');
            dateSpan.className = 'drop-date';
            dateSpan.appendChild(document.createTextNode('📅 ' + date + ' '));
            const deleteSpan = document.createElement('span');
            deleteSpan.className = 'drop-date-delete';
            deleteSpan.dataset.action = 'remove-date';
            deleteSpan.dataset.date = date;
            deleteSpan.dataset.messageId = drop.discord_message_id;
            deleteSpan.dataset.bookId = bookFractalId;
            deleteSpan.textContent = '×';
            dateSpan.appendChild(deleteSpan);
            datesDiv.appendChild(dateSpan);
        });
        display.appendChild(datesDiv);
    }
    
    // Show or hide display based on content
    if (tags.length > 0 || dates.length > 0) {
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
    }
}

// Show tag input dialog (modal)
function showTagInputDialog(messageId, bookId) {
    // Create modal overlay
    const modal = document.createElement('div');
    modal.className = 'tag-input-modal';
    
    const dialog = document.createElement('div');
    dialog.className = 'tag-input-dialog';
    
    const title = document.createElement('h3');
    title.textContent = '🏷️ Add Tags & Dates';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `tag-input-${messageId}`;
    input.placeholder = '#FromDad Christmas 2021';
    input.autocomplete = 'off';
    
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'tag-input-dialog-buttons';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel-btn';
    cancelBtn.dataset.action = 'close-tag-dialog';
    cancelBtn.textContent = 'Cancel';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.dataset.action = 'save-tag-dialog';
    saveBtn.dataset.messageId = messageId;
    saveBtn.dataset.bookId = bookId;
    saveBtn.textContent = 'Save';
    
    buttonsDiv.appendChild(cancelBtn);
    buttonsDiv.appendChild(saveBtn);
    dialog.appendChild(title);
    dialog.appendChild(input);
    dialog.appendChild(buttonsDiv);
    modal.appendChild(dialog);
    
    document.body.appendChild(modal);
    
    // Focus input
    input.focus();
    
    // Close on overlay click
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.hasAttribute('data-action') && e.target.getAttribute('data-action') === 'close-tag-dialog') {
            modal.remove();
        }
    });
    
    // Save on button click
    modal.addEventListener('click', async (e) => {
        if (e.target.hasAttribute('data-action') && e.target.getAttribute('data-action') === 'save-tag-dialog') {
            const metadataText = input.value.trim();
            if (metadataText) {
                const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"][data-book-id="${bookId}"]`);
                if (section) {
                    await saveDrop(bookId, messageId, metadataText, section);
                }
            }
            modal.remove();
        }
    });
    
    // Save on Enter key
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const metadataText = input.value.trim();
            if (metadataText) {
                const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"][data-book-id="${bookId}"]`);
                if (section) {
                    await saveDrop(bookId, messageId, metadataText, section);
                }
            }
            modal.remove();
        }
    });
}

// Show bulk tag modal for multiple messages
function showBulkTagModal(bookId) {
    // Get selected message IDs
    const selectedIds = selectedMessages[bookId] ? Array.from(selectedMessages[bookId]) : [];
    
    if (selectedIds.length === 0) {
        showToast('❌ Please select messages to tag', 'error');
        return;
    }
    
    // Create modal overlay
    const modal = document.createElement('div');
    modal.className = 'tag-input-modal';
    
    const dialog = document.createElement('div');
    dialog.className = 'tag-input-dialog';
    
    const title = document.createElement('h3');
    title.textContent = `🏷️ Bulk Tag ${selectedIds.length} Message${selectedIds.length > 1 ? 's' : ''}`;
    
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'bulk-tag-input';
    input.placeholder = '#FromDad Christmas 2021';
    input.autocomplete = 'off';
    
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'tag-input-dialog-buttons';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel-btn';
    cancelBtn.dataset.action = 'close-bulk-tag-dialog';
    cancelBtn.textContent = 'Cancel';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.dataset.action = 'save-bulk-tag-dialog';
    saveBtn.dataset.bookId = bookId;
    saveBtn.textContent = 'Apply to All';
    
    buttonsDiv.appendChild(cancelBtn);
    buttonsDiv.appendChild(saveBtn);
    dialog.appendChild(title);
    dialog.appendChild(input);
    dialog.appendChild(buttonsDiv);
    modal.appendChild(dialog);
    
    document.body.appendChild(modal);
    
    // Focus input
    input.focus();
    
    // Close on overlay click
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.hasAttribute('data-action') && e.target.getAttribute('data-action') === 'close-bulk-tag-dialog') {
            modal.remove();
        }
    });
    
    // Save on button click
    modal.addEventListener('click', async (e) => {
        if (e.target.hasAttribute('data-action') && e.target.getAttribute('data-action') === 'save-bulk-tag-dialog') {
            const metadataText = input.value.trim();
            if (metadataText) {
                showToast(`🏷️ Applying tags to ${selectedIds.length} message(s)...`, 'info');
                
                // Apply tags to all selected messages
                let successCount = 0;
                for (const messageId of selectedIds) {
                    const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"][data-book-id="${bookId}"]`);
                    if (section) {
                        try {
                            await saveDrop(bookId, messageId, metadataText, section);
                            successCount++;
                        } catch (error) {
                            console.error(`Failed to tag message ${messageId}:`, error);
                        }
                    }
                }
                
                showToast(`✅ Tagged ${successCount}/${selectedIds.length} message(s)`, 'success');
                
                // Clear selections and update buttons
                const checkboxes = document.querySelectorAll(`input.message-checkbox[data-book-id="${bookId}"]`);
                checkboxes.forEach(cb => cb.checked = false);
                selectedMessages[bookId].clear();
                updateBulkActionButtons(bookId);
            }
            modal.remove();
        }
    });
    
    // Save on Enter key
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const metadataText = input.value.trim();
            if (metadataText) {
                showToast(`🏷️ Applying tags to ${selectedIds.length} message(s)...`, 'info');
                
                // Apply tags to all selected messages
                let successCount = 0;
                for (const messageId of selectedIds) {
                    const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"][data-book-id="${bookId}"]`);
                    if (section) {
                        try {
                            await saveDrop(bookId, messageId, metadataText, section);
                            successCount++;
                        } catch (error) {
                            console.error(`Failed to tag message ${messageId}:`, error);
                        }
                    }
                }
                
                showToast(`✅ Tagged ${successCount}/${selectedIds.length} message(s)`, 'success');
                
                // Clear selections and update buttons
                const checkboxes = document.querySelectorAll(`input.message-checkbox[data-book-id="${bookId}"]`);
                checkboxes.forEach(cb => cb.checked = false);
                selectedMessages[bookId].clear();
                updateBulkActionButtons(bookId);
            }
            modal.remove();
        }
    });
}

// Hydrate drops for all messages in a book
async function hydrateDropsForBook(bookId) {
    const drops = await fetchDrops(bookId);
    
    drops.forEach(drop => {
        const section = document.querySelector(`.message-drop-section[data-message-id="${drop.discord_message_id}"][data-book-id="${bookId}"]`);
        if (section) {
            displayDrop(section, drop, null, bookId); // Pass fractal_id
        }
    });
}

// This script will be appended to dashboard.js to handle event delegation
// for dynamically generated elements

// Event delegation for all dynamically generated elements
document.addEventListener('click', function(e) {
    const target = e.target;
    
    // Tag removal (BOT WIZARD ONLY - not for drops metadata)
    // Skip if this is a drops tag (has data-action="remove-tag")
    if (target.classList.contains('tag-remove') && !target.hasAttribute('data-action')) {
        e.preventDefault();
        const tag = target.getAttribute('data-tag');
        if (tag) removeTag(tag);
        return;
    }
    
    // Webhook removal
    if (target.hasAttribute('data-remove-webhook')) {
        e.preventDefault();
        const webhookId = parseInt(target.getAttribute('data-remove-webhook'));
        if (webhookId) removeWebhook(webhookId);
        return;
    }
    
    // Book selection (supports both old button style and new list widget style)
    if (target.classList.contains('book-list-item') || target.closest('.book-list-item') || 
        target.classList.contains('channel-item') || target.closest('.channel-item')) {
        const item = target.classList.contains('book-list-item') ? target : 
                     target.closest('.book-list-item') ||
                     (target.classList.contains('channel-item') ? target : target.closest('.channel-item'));
        const fractalId = item.getAttribute('data-fractal-id');
        if (fractalId && !item.classList.contains('active') && !item.classList.contains('selected')) {
            selectBook(fractalId);
        }
        return;
    }
    
    // Show book info modal button (unified desktop & mobile)
    if (target.hasAttribute('data-show-book-info')) {
        e.preventDefault();
        showBookInfoModal();
        return;
    }
    
    // Show WhatsApp activation modal button (2-message flow)
    if (target.hasAttribute('data-show-whatsapp-activation')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-show-whatsapp-activation');
        if (fractalId) showWhatsAppActivationModal(fractalId);
        return;
    }
    
    // Edit book button
    if (target.hasAttribute('data-edit-book')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-edit-book');
        if (fractalId) editBook(fractalId);
        return;
    }
    
    // Download entire book button
    if (target.hasAttribute('data-download-entire-book')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-download-entire-book');
        if (fractalId) downloadEntireBook(fractalId);
        return;
    }
    
    // Delete book button
    if (target.hasAttribute('data-delete-book')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-delete-book');
        if (fractalId) confirmDeleteBook(fractalId);
        return;
    }
    
    // Download book data button
    if (target.hasAttribute('data-download-book')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-download-book');
        if (fractalId) downloadBookData(fractalId);
        return;
    }
    
    // Bulk tag button
    if (target.hasAttribute('data-tag-book')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-tag-book');
        if (fractalId) showBulkTagModal(fractalId);
        return;
    }
    
    // Clear book search filter
    if (target.hasAttribute('data-clear-filter')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-clear-filter');
        if (fractalId) clearBookSearchFilter(fractalId);
        return;
    }
    
    // Table column sorting
    if (target.closest('th[data-sort-column]')) {
        const th = target.closest('th[data-sort-column]');
        const bookId = th.getAttribute('data-book-id');
        const column = th.getAttribute('data-sort-column');
        if (bookId && column) sortMessagesTable(bookId, column);
        return;
    }
    
    // Revoke session button
    if (target.hasAttribute('data-revoke-session')) {
        e.preventDefault();
        const sessionId = parseInt(target.getAttribute('data-revoke-session'));
        if (sessionId) revokeSession(sessionId);
        return;
    }
    
    // Media preview - handle any element with data-message-id (images, videos, attachments)
    // EXCLUDE interactive form elements (checkboxes, text inputs, buttons) AND action buttons (tag/date delete)
    const isInteractiveElement = target.tagName === 'INPUT' || 
                                   target.tagName === 'TEXTAREA' || 
                                   target.tagName === 'BUTTON' || 
                                   target.tagName === 'LABEL' ||
                                   target.closest('label') ||
                                   target.closest('button') ||
                                   target.hasAttribute('data-action');
    
    if (target.hasAttribute('data-message-id') && !target.closest('video') && !isInteractiveElement) {
        e.preventDefault();
        const msgId = parseInt(target.getAttribute('data-message-id'));
        if (msgId) showMediaPreview(msgId);
        return;
    }
    
    // Discord thread link
    if (target.hasAttribute('data-discord-thread')) {
        e.preventDefault();
        const threadId = target.getAttribute('data-discord-thread');
        if (threadId) window.open(`https://discord.com/channels/@me/${threadId}`, '_blank');
        return;
    }
    
    // Discord DM link
    if (target.hasAttribute('data-discord-open')) {
        e.preventDefault();
        window.open('https://discord.com/channels/@me', '_blank');
        return;
    }
    
    // Pagination buttons (legacy - now uses infinite scroll)
    if (target.hasAttribute('data-load-page')) {
        e.preventDefault();
        const bookId = target.getAttribute('data-book-id');
        if (bookId) loadBookMessages(bookId, true);  // append=true for loading more
        return;
    }
    
    // User management buttons
    if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'openCreateUserModal') {
        e.preventDefault();
        openCreateUserModal();
        return;
    }
    
    if (target.hasAttribute('data-delete-user')) {
        e.preventDefault();
        const userId = target.getAttribute('data-delete-user');
        if (userId) deleteUser(userId);
        return;
    }
    
    // Modal close
    if (target.hasAttribute('data-close-modal')) {
        e.preventDefault();
        const modalId = target.getAttribute('data-close-modal');
        if (modalId) closeModal(modalId);
        return;
    }
    
    // Dev panel book selection
    if (target.hasAttribute('data-dev-book')) {
        const fractalId = target.getAttribute('data-dev-book');
        if (fractalId) selectDevBook(fractalId);
        return;
    }
    
    // Hint dismissal (CSP-safe event delegation)
    if (target.classList.contains('close-hint') || target.hasAttribute('data-dismiss-hint')) {
        e.preventDefault();
        e.stopPropagation();
        const hintKey = target.getAttribute('data-dismiss-hint');
        if (hintKey) {
            localStorage.setItem(`hint_${hintKey}`, 'dismissed');
            target.closest('.onboarding-hint')?.remove();
        }
        return;
    }
    
    // ============ DROPS - Personal Cloud OS ============
    // Audit button - action & closure
    if (target.classList.contains('agent-btn')) {
        e.preventDefault();
        const messageId = target.getAttribute('data-message-id');
        const bookId = target.getAttribute('data-book-id');
        alert('🧿 Audit\n\nAction & closure features coming soon!');
        return;
    }
    
    // Tag add button - open modal dialog
    if (target.classList.contains('tag-add-btn')) {
        e.preventDefault();
        const messageId = target.getAttribute('data-message-id');
        const bookId = target.getAttribute('data-book-id');
        showTagInputDialog(messageId, bookId);
        return;
    }
    
    // Jump to message button - scroll and highlight with URL update
    if (target.classList.contains('jump-to-msg-btn')) {
        e.preventDefault();
        const messageId = target.getAttribute('data-msg-id');
        const bookId = target.getAttribute('data-book-id');
        console.log(`🚀 Jump button clicked: msgId=${messageId}, bookId=${bookId}`);
        if (messageId && bookId) {
            jumpToMessage(messageId, bookId);
        }
        return;
    }
    
    // Search preview bubble click - jump to target message
    if (target.closest('.search-preview-bubble') || target.classList.contains('preview-jump')) {
        e.preventDefault();
        const bubble = target.closest('.search-preview-bubble');
        if (bubble) {
            const targetId = bubble.getAttribute('data-target-id');
            const bookId = selectedBookFractalId;
            if (targetId && bookId) {
                jumpToMessage(targetId, bookId);
            }
        }
        return;
    }
    
    // Timeline bucket header - jump to first visible message in bucket
    if (target.closest('.time-bucket-header')) {
        e.preventDefault();
        const bucketHeader = target.closest('.time-bucket-header');
        const bookId = bucketHeader.getAttribute('data-book-id');
        
        if (bookId) {
            // Find first visible message after this bucket header
            let currentEl = bucketHeader.nextElementSibling;
            let firstVisibleMsgId = null;
            
            // Skip preview container
            if (currentEl && currentEl.classList.contains('search-preview-container')) {
                currentEl = currentEl.nextElementSibling;
            }
            
            while (currentEl && !currentEl.classList.contains('time-bucket-header')) {
                if (currentEl.classList.contains('discord-message') && currentEl.style.display !== 'none') {
                    firstVisibleMsgId = currentEl.getAttribute('data-msg-id');
                    break;
                }
                currentEl = currentEl.nextElementSibling;
            }
            
            if (firstVisibleMsgId) {
                jumpToMessage(firstVisibleMsgId, bookId);
            } else {
                // Fallback to data attribute if no visible messages found
                const firstMsgId = bucketHeader.getAttribute('data-first-msg-id');
                if (firstMsgId) {
                    jumpToMessage(firstMsgId, bookId);
                }
            }
        }
        return;
    }
    
    // Save drop button
    if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'save-drop') {
        e.preventDefault();
        const messageId = target.getAttribute('data-message-id');
        const bookId = target.getAttribute('data-book-id');
        const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"]`);
        const input = section?.querySelector('.drop-input');
        const metadataText = input?.value.trim();
        
        if (metadataText && bookId) {
            saveDrop(bookId, messageId, metadataText, section);
        }
        return;
    }
    
    // Remove tag button (× on tag bubble)
    if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'remove-tag') {
        e.preventDefault();
        
        console.log('🔍 Tag remove button clicked!');
        console.log('Target element:', target);
        console.log('Target HTML:', target.outerHTML);
        console.log('All datasets:', target.dataset);
        
        const tag = target.getAttribute('data-tag');
        const messageId = target.getAttribute('data-message-id');
        const bookId = target.getAttribute('data-book-id');
        
        console.log('Extracted attributes:', { tag, messageId, bookId });
        
        if (tag && messageId && bookId) {
            removeTag(bookId, messageId, tag);
        } else {
            console.error('❌ Missing attributes for tag removal!', { tag, messageId, bookId });
        }
        return;
    }
    
    // Remove date button (× on date bubble)
    if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'remove-date') {
        e.preventDefault();
        
        const date = target.getAttribute('data-date');
        const messageId = target.getAttribute('data-message-id');
        const bookId = target.getAttribute('data-book-id');
        
        console.log('🗑️ Date remove button clicked:', { date, messageId, bookId });
        
        if (date && messageId && bookId) {
            removeDate(bookId, messageId, date);
        } else {
            console.error('❌ Missing attributes for date removal!', { date, messageId, bookId });
        }
        return;
    }
    
    // Custom checkbox styling - toggle checked state visually
    if (target.closest('.custom-checkbox-btn')) {
        const label = target.closest('.custom-checkbox-btn');
        const checkbox = label.querySelector('input[type="checkbox"]');
        const icon = label.querySelector('.checkbox-icon');
        
        if (checkbox && icon) {
            // Toggle will happen automatically, we just update the icon
            setTimeout(() => {
                icon.textContent = checkbox.checked ? '☑' : '☐';
            }, 0);
        }
        return;
    }
});

// Event delegation for input changes on dynamically generated elements
document.addEventListener('input', function(e) {
    const target = e.target;
    
    // Webhook name/URL updates
    if (target.hasAttribute('data-webhook-id') && target.hasAttribute('data-webhook-field')) {
        const webhookId = parseInt(target.getAttribute('data-webhook-id'));
        const field = target.getAttribute('data-webhook-field');
        if (webhookId && field) updateWebhook(webhookId, field, target.value);
        return;
    }
    
    // Discord messages filter
    if (target.hasAttribute('data-filter-messages')) {
        const fractalId = target.getAttribute('data-filter-messages');
        if (fractalId) filterDiscordMessages(fractalId);
        return;
    }
    
    // Message table filter
    if (target.hasAttribute('data-filter-table')) {
        const bookId = target.getAttribute('data-filter-table');
        if (bookId) filterMessagesTable(bookId);
        return;
    }
});

// ============================================================================
// SIDEBAR RESIZER - Draggable width adjustment
// ============================================================================
(function initSidebarResizer() {
    const resizer = document.getElementById('sidebarResizer');
    const sidebar = document.getElementById('bookSidebar');
    
    if (!resizer || !sidebar) return;
    
    // Min/max constraints
    const MIN_WIDTH = 180;
    const MAX_WIDTH = 400;
    const STORAGE_KEY = 'nyanbook_sidebar_width';
    
    // Load saved width from localStorage
    const savedWidth = localStorage.getItem(STORAGE_KEY);
    if (savedWidth) {
        const width = parseInt(savedWidth);
        if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
            document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
        }
    }
    
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    function startResize(e) {
        // Only allow resize on tablet/desktop
        if (window.innerWidth < 768) return;
        
        isResizing = true;
        startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        startWidth = sidebar.offsetWidth;
        
        resizer.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        
        e.preventDefault();
        
        // Add dynamic touch listeners only during active resize
        // (non-passive so e.preventDefault() works; removed in stopResize)
        if (e.type.includes('touch')) {
            document.addEventListener('touchmove', resize, { passive: false });
            document.addEventListener('touchend', stopResize);
        }
    }
    
    function resize(e) {
        if (!isResizing) return;
        
        const currentX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        const diff = currentX - startX;
        let newWidth = startWidth + diff;
        
        // Apply constraints
        newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));
        
        // Update CSS custom property
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
        
        e.preventDefault();
    }
    
    function stopResize() {
        if (!isResizing) return;
        
        isResizing = false;
        resizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        
        // Remove dynamic touch listeners now that resize is done
        document.removeEventListener('touchmove', resize);
        document.removeEventListener('touchend', stopResize);
        
        // Save to localStorage
        const currentWidth = sidebar.offsetWidth;
        localStorage.setItem(STORAGE_KEY, currentWidth.toString());
    }
    
    // Mouse events (permanent — mousemove doesn't block scroll)
    resizer.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
    
    // Touch: only touchstart is permanent; touchmove/touchend added dynamically in startResize
    resizer.addEventListener('touchstart', startResize, { passive: false });
})();

// ============================================================================
// HEADER RESIZER - Draggable height adjustment
// ============================================================================
(function initHeaderResizer() {
    const resizer = document.getElementById('headerResizer');
    const header = document.querySelector('.header');
    
    if (!resizer || !header) return;
    
    // Min/max constraints for header height
    const MIN_HEIGHT = 55; // Ensures cat and logout button always visible
    const MAX_HEIGHT = 120;
    const STORAGE_KEY = 'nyanbook_header_height';
    
    // Load saved height from localStorage
    const savedHeight = localStorage.getItem(STORAGE_KEY);
    if (savedHeight) {
        const height = parseInt(savedHeight);
        if (height >= MIN_HEIGHT && height <= MAX_HEIGHT) {
            document.documentElement.style.setProperty('--header-height', `${height}px`);
        }
    }
    
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    
    function startResize(e) {
        isResizing = true;
        startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
        startHeight = header.offsetHeight;
        
        resizer.classList.add('resizing');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        
        e.preventDefault();
        
        // Add dynamic touch listeners only during active resize
        // (non-passive so e.preventDefault() works; removed in stopResize)
        if (e.type.includes('touch')) {
            document.addEventListener('touchmove', resize, { passive: false });
            document.addEventListener('touchend', stopResize);
        }
    }
    
    function resize(e) {
        if (!isResizing) return;
        
        const currentY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
        const diff = currentY - startY;
        let newHeight = startHeight + diff;
        
        // Apply constraints
        newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, newHeight));
        
        // Update CSS custom property
        document.documentElement.style.setProperty('--header-height', `${newHeight}px`);
        
        e.preventDefault();
    }
    
    function stopResize() {
        if (!isResizing) return;
        
        isResizing = false;
        resizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        
        // Remove dynamic touch listeners now that resize is done
        document.removeEventListener('touchmove', resize);
        document.removeEventListener('touchend', stopResize);
        
        // Save to localStorage
        const currentHeight = header.offsetHeight;
        localStorage.setItem(STORAGE_KEY, currentHeight.toString());
    }
    
    // Mouse events (permanent — mousemove doesn't block scroll)
    resizer.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
    
    // Touch: only touchstart is permanent; touchmove/touchend added dynamically in startResize
    resizer.addEventListener('touchstart', startResize, { passive: false });
})();

// ============================================================================
// ADAPTIVE DATE/TIME POSITIONING - Responsive to header height
// ============================================================================
(function initAdaptiveDateTimePosition() {
    const dateTimeDefault = document.getElementById('dateTimeDefault');
    const dateTimeCompact = document.getElementById('dateTimeCompact');
    const currentTime = document.getElementById('currentTime');
    const currentTimeCompact = document.getElementById('currentTimeCompact');
    const header = document.querySelector('.header');
    
    if (!dateTimeDefault || !dateTimeCompact || !header) return;
    
    // Threshold: below 65px, switch to compact mode
    const COMPACT_THRESHOLD = 65;
    
    function updateDateTimePosition() {
        const headerHeight = header.offsetHeight;
        
        if (headerHeight < COMPACT_THRESHOLD) {
            // Compact mode: hide default, show compact
            dateTimeDefault.style.display = 'none';
            dateTimeCompact.style.display = 'block';
        } else {
            // Default mode: show default, hide compact
            dateTimeDefault.style.display = 'block';
            dateTimeCompact.style.display = 'none';
        }
    }
    
    // Update position on load
    updateDateTimePosition();
    
    // Watch for header height changes (triggered by resizer)
    const observer = new MutationObserver(() => {
        updateDateTimePosition();
    });
    
    // Observe style changes on document root (--header-height changes)
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style']
    });
    
    // Also check periodically to catch any missed updates
    setInterval(() => {
        updateDateTimePosition();
    }, 500);
})();
