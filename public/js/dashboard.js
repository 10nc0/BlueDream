        console.log('🚀 Main script loading...');
        let bridges = [];
        let filteredBridges = [];
        let editingBridgeId = null;
        let expandedBots = new Set();
        
        // SECURITY: Message cache is TENANT-ISOLATED via fractalized bridge IDs
        // Keys MUST be fractal_id (dev_bridge_tX_HASH or prod_bridge_tX_HASH)
        // This ensures zero cross-tenant data leakage in multi-tenant SaaS
        let messageCache = {}; 
        
        let allMessages = {}; // Store all messages by ID for media viewing
        let currentUser = null;
        
        // SEAMLESS SEARCH: Store bridge search query for auto-filtering messages
        // When user searches in bridge library and clicks a 💬 bridge, 
        // this context auto-filters messages without double search
        let bridgeSearchContext = {
            query: '',
            bridgeId: null
        };
        let botTags = []; // Store tags as array
        let botWebhooks = []; // Store webhook outputs for 1-to-many feature
        let users = [];
        let sessions = [];
        
        // Per-message export: Track selected message IDs per bridge
        let selectedMessages = {}; // { bridgeId: Set([msgId1, msgId2, ...]) }
        
        // Platform roadmap for future features
        const roadmapGlossary = {
            platforms: {
                coming_soon: ['Telegram', 'Line', 'Signal', 'WeChat']
            }
        };

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

        // JWT-enabled fetch wrapper - automatically adds Authorization header
        async function authFetch(url, options = {}) {
            const accessToken = localStorage.getItem('accessToken');
            
            // Always set Content-Type for JSON requests
            options.headers = {
                'Content-Type': 'application/json',
                ...options.headers
            };
            
            // Add Authorization header if token exists
            if (accessToken) {
                options.headers['Authorization'] = `Bearer ${accessToken}`;
            }
            
            // NOTE: Do NOT use credentials: 'include' for JWT auth (that's for cookies only)
            
            let response = await fetch(url, options);
            
            // If token expired (401), try to refresh
            if (response.status === 401 && accessToken) {
                const refreshToken = localStorage.getItem('refreshToken');
                
                if (refreshToken) {
                    try {
                        // Try to refresh the access token
                        const refreshResponse = await fetch('/api/auth/refresh', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ refreshToken })
                        });
                        
                        if (refreshResponse.ok) {
                            const refreshData = await refreshResponse.json();
                            localStorage.setItem('accessToken', refreshData.accessToken);
                            
                            // Retry original request with new token
                            options.headers['Authorization'] = `Bearer ${refreshData.accessToken}`;
                            response = await fetch(url, options);
                        } else {
                            // Refresh failed, clear tokens and redirect to login
                            localStorage.removeItem('accessToken');
                            localStorage.removeItem('refreshToken');
                            window.location.href = '/login.html';
                            return response;
                        }
                    } catch (refreshError) {
                        console.error('Token refresh failed:', refreshError);
                        localStorage.removeItem('accessToken');
                        localStorage.removeItem('refreshToken');
                        window.location.href = '/login.html';
                        return response;
                    }
                } else {
                    // No refresh token, redirect to login
                    window.location.href = '/login.html';
                    return response;
                }
            }
            
            return response;
        }

        // Check authentication on page load
        async function checkAuth() {
            try {
                const res = await authFetch('/api/auth/status');
                const data = await res.json();
                
                if (!data.authenticated) {
                    window.location.href = '/login.html';
                    return false;
                }
                
                currentUser = data.user;
                const userInfo = document.getElementById('userInfo');
                const roleColors = {
                    'dev': '#ffffff',
                    'admin': '#10b981',
                    'user': '#60a5fa',
                    'read-only': '#f59e0b',
                    'write-only': '#3b82f6'
                };
                userInfo.innerHTML = `<span style="color: ${roleColors[currentUser.role] || '#94a3b8'}; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.4;">
                    <span>● ${currentUser.email || currentUser.phone}</span>
                    <span style="font-size: 0.85em; opacity: 0.9;">(${currentUser.role})</span>
                </span>`;
                
                // Role hierarchy: dev > admin > user
                // Show tabs based on role AND genesis admin status
                const devTab = document.getElementById('devPanelBtn');
                const usersTabBtn = document.getElementById('usersTabBtn');
                
                // Genesis admins get dev role and full access
                const isGenesisAdmin = currentUser.isGenesisAdmin || currentUser.is_genesis_admin;
                
                if (currentUser.role === 'dev' || isGenesisAdmin) {
                    // Devs and Genesis Admins see everything including dev panel
                    if (devTab) devTab.style.display = 'block';
                    if (usersTabBtn) usersTabBtn.style.display = 'block';
                    
                    // Add visual indicator for Genesis Admin
                    if (isGenesisAdmin) {
                        userInfo.innerHTML = `<span style="color: ${roleColors[currentUser.role] || '#94a3b8'}; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.4;">
                            <span>● ${currentUser.email || currentUser.phone}</span>
                            <span style="font-size: 0.85em; opacity: 0.9;">(${currentUser.role}) 🌟 Genesis</span>
                        </span>`;
                    }
                } else if (currentUser.role === 'admin') {
                    // Regular admins see users tab but not dev panel
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
            try {
                await authFetch('/api/auth/logout', { method: 'POST' });
            } catch (error) {
                console.error('Logout API error:', error);
            }
            
            // SECURITY: Clear all cached data to prevent cross-session data leakage
            messageCache = {};
            allMessages = {};
            bridges = [];
            filteredBridges = [];
            
            // Clear JWT tokens from localStorage (Safari-safe)
            try {
                localStorage.removeItem('accessToken');
                localStorage.removeItem('refreshToken');
                localStorage.clear(); // Clear all localStorage for Safari
                sessionStorage.clear(); // Clear sessionStorage too
            } catch (e) {
                console.log('Storage clear error (Safari private mode?):', e);
            }
            
            // Force redirect after short delay for Safari
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
            botTags = botTags.filter(t => t !== tag);
            renderTags();
        }

        function renderTags() {
            const container = document.getElementById('tagContainer');
            const input = document.getElementById('botTagsInput');
            
            // Clear container except input
            container.innerHTML = '';
            
            // Add tag bubbles
            botTags.forEach(tag => {
                const bubble = document.createElement('div');
                bubble.className = 'tag-bubble';
                bubble.innerHTML = `
                    ${tag}
                    <button type="button" class="tag-remove" data-tag="${tag}">×</button>
                `;
                container.appendChild(bubble);
            });
            
            // Re-add input
            container.appendChild(input);
        }

        // Webhook Management Functions for 1-to-Many Output
        function addWebhookInput() {
            const webhookId = Date.now();
            botWebhooks.push({ id: webhookId, url: '', name: '' });
            renderWebhooks();
        }

        function removeWebhook(webhookId) {
            botWebhooks = botWebhooks.filter(w => w.id !== webhookId);
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
            container.innerHTML = botWebhooks.map(webhook => `
                <div style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center;">
                    <input 
                        type="text" 
                        class="form-input" 
                        placeholder="Webhook Name (e.g., Main Channel)" 
                        value="${escapeHtml(webhook.name)}"
                        data-webhook-id="${webhook.id}"
                        data-webhook-field="name"
                        style="flex: 0 0 30%;"
                    >
                    <input 
                        type="url" 
                        class="form-input" 
                        placeholder="Webhook URL" 
                        value="${escapeHtml(webhook.url)}"
                        data-webhook-id="${webhook.id}"
                        data-webhook-field="url"
                        style="flex: 1;"
                    >
                    <button 
                        type="button" 
                        class="btn" 
                        data-remove-webhook="${webhook.id}"
                        style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; padding: 0.5rem 1rem;"
                    >×</button>
                </div>
            `).join('');
        }

        // Bridge CRUD Functions
        async function loadBridges() {
            try {
                const response = await authFetch('/api/bridges');
                bridges = await response.json();
                filteredBridges = bridges;
                renderBridges();
                updatePlatformFilter();
            } catch (error) {
                console.error('Error loading bridges:', error);
            }
        }

        // Auto-refresh bridge counts every 10 seconds to keep message counts updated
        // Use skipDetailRender=true to avoid destroying loaded media
        setInterval(() => {
            if (document.getElementById('bridgesTab')?.classList.contains('active')) {
                loadBridgesQuietly();
            }
        }, 10000);
        
        // Quiet refresh that updates bridge counts without re-rendering detail panel
        async function loadBridgesQuietly() {
            try {
                const response = await authFetch('/api/bridges');
                bridges = await response.json();
                filteredBridges = bridges;
                renderBridges(true); // Skip detail render to preserve loaded media
            } catch (error) {
                console.error('Error loading bridges:', error);
            }
        }

        let selectedBridgeFractalId = null;

        function renderBridges(skipDetailRender = false) {
            const sidebar = document.getElementById('bridgeListContainer');
            const detail = document.getElementById('bridgeDetail');
            
            if (filteredBridges.length === 0) {
                sidebar.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 2rem; font-size: 0.875rem;">No bridges found</p>';
                detail.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 2rem;">Create your first bridge to get started!</p>';
                return;
            }
            
            // Auto-select first bridge if none selected (use fractalized ID)
            const wasAutoSelected = !selectedBridgeFractalId || !filteredBridges.find(b => b.fractal_id === selectedBridgeFractalId);
            if (wasAutoSelected) {
                selectedBridgeFractalId = filteredBridges[0].fractal_id;
            }
            
            // Clean WhatsApp-style list (no platform grouping)
            sidebar.innerHTML = filteredBridges.map(bridge => `
                <button class="channel-item ${bridge.fractal_id === selectedBridgeFractalId ? 'active' : ''}" data-fractal-id="${bridge.fractal_id}" style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; border: none; background: ${bridge.fractal_id === selectedBridgeFractalId ? 'rgba(88, 101, 242, 0.1)' : 'transparent'}; border-left: 2px solid ${bridge.fractal_id === selectedBridgeFractalId ? '#818cf8' : 'transparent'}; cursor: pointer; width: 100%; text-align: left; transition: all 0.15s; margin: 0.125rem 0;">
                    <div style="flex: 1; min-width: 0;">
                        <div style="color: ${bridge.fractal_id === selectedBridgeFractalId ? '#e2e8f0' : '#cbd5e1'}; font-weight: ${bridge.fractal_id === selectedBridgeFractalId ? '600' : '500'}; font-size: 0.8125rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${bridge.name || `${bridge.input_platform} → Discord`}</div>
                        ${bridge.message_count > 0 ? `<div style="color: #64748b; font-size: 0.6875rem; margin-top: 0.125rem;">${bridge.message_count}</div>` : ''}
                    </div>
                    ${bridge._matchType === 'message' ? `<span style="background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.25); color: #22c55e; padding: 0.125rem 0.3rem; border-radius: 3px; font-size: 0.7rem; margin-left: 0.5rem;">💬</span>` : ''}
                </button>
            `).join('');
            
            // Only render detail panel if not skipping (avoids destroying loaded media during auto-refresh)
            if (!skipDetailRender) {
                renderBridgeDetail();
                
                // Always load messages for selected bridge to ensure they appear
                loadBridgeMessages(selectedBridgeFractalId, 1);
            }
        }

        async function selectBridge(fractalId) {
            // Store fractalized ID (opaque, non-enumerable)
            selectedBridgeFractalId = fractalId;
            
            // SEAMLESS SEARCH: Store search context if this bridge has message match
            const selectedBridge = filteredBridges.find(b => b.fractal_id === fractalId);
            if (selectedBridge && selectedBridge._matchType === 'message' && selectedBridge._searchQuery) {
                bridgeSearchContext = {
                    query: selectedBridge._searchQuery,
                    bridgeId: fractalId
                };
            } else {
                // Clear context if not a message match
                bridgeSearchContext = { query: '', bridgeId: null };
            }
            
            // Re-render sidebar to update active state
            const sidebar = document.getElementById('bridgeListContainer');
            
            sidebar.innerHTML = filteredBridges.map(bridge => `
                <button class="channel-item ${bridge.fractal_id === selectedBridgeFractalId ? 'active' : ''}" data-fractal-id="${bridge.fractal_id}" style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; border: none; background: ${bridge.fractal_id === selectedBridgeFractalId ? 'rgba(88, 101, 242, 0.1)' : 'transparent'}; border-left: 2px solid ${bridge.fractal_id === selectedBridgeFractalId ? '#818cf8' : 'transparent'}; cursor: pointer; width: 100%; text-align: left; transition: all 0.15s; margin: 0.125rem 0;">
                    <div style="flex: 1; min-width: 0;">
                        <div style="color: ${bridge.fractal_id === selectedBridgeFractalId ? '#e2e8f0' : '#cbd5e1'}; font-weight: ${bridge.fractal_id === selectedBridgeFractalId ? '600' : '500'}; font-size: 0.8125rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${bridge.name || `${bridge.input_platform} → Discord`}</div>
                        ${bridge.message_count > 0 ? `<div style="color: #64748b; font-size: 0.6875rem; margin-top: 0.125rem;">${bridge.message_count}</div>` : ''}
                    </div>
                    ${bridge._matchType === 'message' ? `<span style="background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.25); color: #22c55e; padding: 0.125rem 0.3rem; border-radius: 3px; font-size: 0.7rem; margin-left: 0.5rem;">💬</span>` : ''}
                </button>
            `).join('');
            
            // Render detail panel for selected bridge
            await renderBridgeDetail();
            
            // Always load messages for newly selected bridge
            await loadBridgeMessages(selectedBridgeFractalId, 1);
        }

        // Helper functions for badge styling
        function getStatusColor(count) {
            if (count === 0) return '';
            if (count > 10) return 'error-high';
            if (count > 5) return 'error-medium';
            return 'error-low';
        }

        function getSuccessBadgeClass(count) {
            if (count === 0) return '';
            if (count > 100) return 'success-high';
            if (count > 50) return 'success-medium';
            return 'success-low';
        }

        async function renderBridgeDetail() {
            const bridge = filteredBridges.find(b => b.fractal_id === selectedBridgeFractalId);
            if (!bridge) return;
            
            // Get status colors based on thresholds
            const failedClass = getStatusColor(bridge.failed_count || 0);
            const successClass = getSuccessBadgeClass(bridge.forwarded_count || 0);
            
            // Fetch WhatsApp status if this is a WhatsApp bot
            let whatsappStatus = null;
            const platform = (bridge.input_platform || bridge.platform || '').toLowerCase();
            if (platform === 'whatsapp') {
                try {
                    const statusResponse = await authFetch(`/api/bridges/${bridge.fractal_id}/status`);
                    if (statusResponse.ok) {
                        whatsappStatus = await statusResponse.json();
                    }
                } catch (error) {
                    console.error('Error fetching WhatsApp status:', error);
                }
            }
            
            // WhatsApp status badge
            const getWhatsAppStatusBadge = () => {
                if (!whatsappStatus) return '';
                const status = whatsappStatus.status;
                const badges = {
                    'ready': '<span class="stat-badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">✅ Connected</span>',
                    'qr_ready': '<span class="stat-badge" style="background: rgba(59, 130, 246, 0.2); color: #3b82f6;">📱 Scan QR</span>',
                    'initializing': '<span class="stat-badge" style="background: rgba(251, 191, 36, 0.2); color: #fbbf24;">⏳ Starting...</span>',
                    'authenticated': '<span class="stat-badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">🔐 Authenticated</span>',
                    'inactive': '<span class="stat-badge" style="background: rgba(148, 163, 184, 0.2); color: #94a3b8;">⏸️ Inactive</span>',
                    'disconnected': '<span class="stat-badge error" style="background: rgba(239, 68, 68, 0.2); color: #ef4444;">🔌 Disconnected</span>',
                    'auth_failed': '<span class="stat-badge error" style="background: rgba(239, 68, 68, 0.2); color: #ef4444;">❌ Auth Failed</span>',
                    'error': '<span class="stat-badge error" style="background: rgba(239, 68, 68, 0.2); color: #ef4444;">⚠️ Error</span>'
                };
                return badges[status] || '';
            };
            
            // WhatsApp action buttons - 3 buttons only: Generate QR, Edit, Delete
            const getWhatsAppActions = () => {
                if (!whatsappStatus) return '';
                
                // Button 1: Generate new QR (starts WhatsApp + shows QR modal)
                return `<button class="btn-icon" data-generate-qr="${bridge.fractal_id}" title="Generate New QR Code" style="background: rgba(59, 130, 246, 0.2); color: #3b82f6;">🔗</button>`;
            };
            
            const detail = document.getElementById('bridgeDetail');
            detail.innerHTML = `
                <!-- Minimal header bar -->
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem; background: rgba(30, 41, 59, 0.6); border-bottom: 1px solid rgba(148, 163, 184, 0.1);">
                    <div style="display: flex; align-items: center; gap: 0.75rem; flex: 1; min-width: 0;">
                        <div style="color: #e2e8f0; font-weight: 600; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${bridge.name || `${platform} → Discord`}</div>
                        ${platform === 'whatsapp' && whatsappStatus ? `<span style="background: ${whatsappStatus === 'ready' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(251, 191, 36, 0.2)'}; color: ${whatsappStatus === 'ready' ? '#10b981' : '#fbbf24'}; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600;">${whatsappStatus === 'ready' ? '✅' : '⏳'}</span>` : ''}
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        ${!isDevPanelView && platform === 'whatsapp' ? `<button class="btn-icon" data-generate-qr="${bridge.fractal_id}" title="Generate QR" style="background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: none; padding: 0.375rem 0.5rem; border-radius: 4px; cursor: pointer; font-size: 0.875rem;">🔗</button>` : ''}
                        ${!isDevPanelView ? `<button class="btn-icon" data-edit-bridge="${bridge.fractal_id}" title="Edit" style="background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: none; padding: 0.375rem 0.5rem; border-radius: 4px; cursor: pointer; font-size: 0.875rem;">✏️</button>` : ''}
                        ${!isDevPanelView ? `<button class="btn-icon" data-delete-bridge="${bridge.fractal_id}" title="Delete" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: none; padding: 0.375rem 0.5rem; border-radius: 4px; cursor: pointer; font-size: 0.875rem;">🗑️</button>` : ''}
                    </div>
                </div>

                ${currentUser?.role === 'dev' && bridge.output_credentials?.output_01?.thread_id ? `
                    <!-- MESSAGES: Full viewport height with minimal chrome -->
                    <div style="display: flex; flex-direction: column; height: calc(100vh - 220px); margin-top: 0.5rem;">
                        <!-- Compact search toolbar -->
                        <div style="display: flex; gap: 0.5rem; padding: 0.5rem; background: rgba(30, 41, 59, 0.4); border-radius: 6px; margin-bottom: 0.5rem;">
                            <label style="display: flex; align-items: center; gap: 0.375rem; padding: 0.375rem 0.625rem; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0; font-size: 0.75rem; cursor: pointer; white-space: nowrap;">
                                <input type="checkbox" id="select-all-${bridge.fractal_id}" data-select-all="${bridge.fractal_id}" style="cursor: pointer;">
                                All
                            </label>
                            <input type="text" id="msg-search-${bridge.fractal_id}" placeholder="🔍 Search..." 
                                style="padding: 0.375rem 0.75rem; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0; font-size: 0.875rem; flex: 1;" 
                                data-filter-messages="${bridge.fractal_id}">
                            <select id="status-filter-${bridge.fractal_id}" data-status-filter="${bridge.fractal_id}"
                                style="padding: 0.375rem 0.75rem; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0; font-size: 0.875rem;">
                                <option value="all">All</option>
                                <option value="success">✓</option>
                                <option value="failed">✗</option>
                            </select>
                            <button id="export-selected-${bridge.fractal_id}" data-export-bridge="${bridge.fractal_id}" disabled style="padding: 0.375rem 0.75rem; background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 0.375rem; color: #22c55e; font-size: 0.75rem; cursor: pointer; white-space: nowrap; opacity: 0.5;">📦 Export</button>
                        </div>
                        <!-- Search indicator (if active) -->
                        <div id="search-indicator-${bridge.fractal_id}" style="display: none; background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 0.375rem; padding: 0.25rem 0.5rem; font-size: 0.75rem; color: #22c55e; align-items: center; gap: 0.5rem; justify-content: space-between; margin-bottom: 0.5rem;">
                            <span>🔍 Filtered from bridge search</span>
                            <button data-clear-filter="${bridge.fractal_id}" style="background: none; border: none; color: #22c55e; cursor: pointer; font-size: 1.25rem; padding: 0; line-height: 1; font-weight: bold;" title="Clear filter">×</button>
                        </div>
                        <!-- Messages: Fill remaining space -->
                        <div id="discord-messages-${bridge.fractal_id}" class="discord-messages-container" style="flex: 1; overflow-y: auto; background: rgba(30, 41, 59, 0.3); border-radius: 6px; padding: 0.75rem;">
                            <div class="no-messages">Loading messages...</div>
                        </div>
                    </div>
                ` : ''}

                <!-- Compact footer: Discord configuration (collapsible, hidden by default) -->
                <details style="margin-top: 0.5rem; background: rgba(88, 101, 242, 0.05); border-radius: 6px; border: 1px solid rgba(88, 101, 242, 0.2); overflow: hidden;">
                    <summary style="padding: 0.5rem 0.75rem; cursor: pointer; font-weight: 600; color: #94a3b8; font-size: 0.8125rem; user-select: none;">
                        ⚙️ Configuration ${bridge.output_credentials?.output_01?.thread_id ? '✓' : ''}
                    </summary>
                    <div style="padding: 1rem; border-top: 1px solid rgba(148, 163, 184, 0.1);">
                        ${currentUser?.role === 'dev' ? `
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                                <div style="background: rgba(0,0,0,0.2); padding: 0.75rem; border-radius: 6px;">
                                    <div style="color: #00ff88; font-size: 0.75rem; font-weight: 600; margin-bottom: 0.5rem;">🔒 Output #01 (Ledger)</div>
                                    <div style="color: #5865f2; font-size: 0.75rem; font-family: monospace;">${bridge.output_credentials?.output_01?.thread_name || 'Not created'}</div>
                                </div>
                                <div style="background: rgba(0,0,0,0.2); padding: 0.75rem; border-radius: 6px;">
                                    <div style="color: #60a5fa; font-size: 0.75rem; font-weight: 600; margin-bottom: 0.5rem;">📡 Output #0n (User)</div>
                                    <div style="color: ${bridge.output_0n_url ? '#22c55e' : '#eab308'}; font-size: 0.75rem;">${bridge.output_0n_url ? '✅ Connected' : '⚠️ Not set'}</div>
                                </div>
                            </div>
                            ${bridge.output_credentials?.output_01?.thread_id ? `
                                <button 
                                    data-discord-thread="${bridge.output_credentials.output_01.thread_id}"
                                    style="width: 100%; background: #5865f2; color: white; padding: 0.5rem; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; font-size: 0.875rem;"
                                >
                                    🚀 Open Thread in Discord
                                </button>
                            ` : ''}
                        ` : `
                            <div style="text-align: center;">
                                <div style="color: ${bridge.output_0n_url ? '#22c55e' : '#eab308'}; font-size: 0.875rem; margin-bottom: 0.75rem;">
                                    ${bridge.output_0n_url ? '✅ Webhook connected' : '⚠️ No webhook configured'}
                                </div>
                                <button 
                                    data-discord-open="true"
                                    style="background: #5865f2; color: white; padding: 0.5rem 1rem; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; font-size: 0.875rem;"
                                >
                                    🚀 Open Discord
                                </button>
                            </div>
                        `}
                    </div>
                </details>
            `;
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
                if (hour === 0) return `${dayLabel} - Night (12am-8am)`;
                if (hour === 8) return `${dayLabel} - Morning (8am-4pm)`;
                if (hour === 16) return `${dayLabel} - Evening (4pm-12am)`;
            } else if (bucketHours === 6) {
                if (hour === 0) return `${dayLabel} - Late Night (12am-6am)`;
                if (hour === 6) return `${dayLabel} - Morning (6am-12pm)`;
                if (hour === 12) return `${dayLabel} - Afternoon (12pm-6pm)`;
                if (hour === 18) return `${dayLabel} - Evening (6pm-12am)`;
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

        // Render Discord-style messages
        function renderDiscordMessages(data, bridgeId) {
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
                const bucketHeader = `
                    <div class="time-bucket-header">
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
                    extractEmbedSearchText(msg.embeds)
                ].join(' ').toLowerCase();
                
                return `
                <div class="discord-message" data-msg-id="${msg.id}" data-search-text="${escapeHtml(searchableText)}" data-status="${msg.discord_status}" style="position: relative;">
                    <div class="discord-avatar">
                        ${msg.sender_photo_url ? 
                            `<img src="${escapeHtml(msg.sender_photo_url)}" alt="${escapeHtml(msg.sender_name || 'User')}" class="avatar-photo" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">
                             <div class="avatar-fallback" style="display: none; width: 100%; height: 100%; align-items: center; justify-content: center;">${msg.sender_name ? msg.sender_name.charAt(0).toUpperCase() : '?'}</div>` :
                            `${msg.sender_name ? msg.sender_name.charAt(0).toUpperCase() : '?'}`
                        }
                    </div>
                    <div class="discord-content">
                        <div class="discord-header-row">
                            <span class="discord-username">${escapeHtml(msg.sender_name || 'Unknown')}</span>
                            <span class="discord-timestamp">${formatDiscordTime(msg.timestamp)}</span>
                            <span class="discord-status-badge status-${msg.discord_status}">${msg.discord_status === 'success' ? '✓' : msg.discord_status === 'failed' ? '✗' : '⏳'}</span>
                        </div>
                        <div class="discord-contact">${formatPhoneNumber(msg.sender_contact)}</div>
                        ${msg.message_content ? `<div class="discord-text">${escapeHtml(msg.message_content)}</div>` : ''}
                        ${msg.embeds && msg.embeds.length > 0 ? msg.embeds.map(embed => `
                            <div class="discord-embed" style="border-left: 4px solid ${embed.color ? '#' + embed.color.toString(16).padStart(6, '0') : '#5865F2'}; background: rgba(47, 49, 54, 0.6); border-radius: 4px; padding: 0.75rem; margin-top: 0.5rem; max-width: 520px;">
                                ${embed.title ? `<div class="embed-title" style="font-weight: 600; color: #00AFF4; margin-bottom: 0.5rem;">${escapeHtml(embed.title)}</div>` : ''}
                                ${embed.description ? `<div class="embed-description" style="color: #DCDDDE; margin-bottom: 0.5rem; white-space: pre-wrap;">${escapeHtml(embed.description)}</div>` : ''}
                                ${embed.fields && embed.fields.length > 0 ? `
                                    <div class="embed-fields" style="display: grid; grid-template-columns: repeat(${embed.fields.some(f => !f.inline) ? '1' : '2'}, 1fr); gap: 0.5rem;">
                                        ${embed.fields.map(field => `
                                            <div class="embed-field" style="${field.inline ? 'display: inline-block;' : ''}">
                                                <div class="embed-field-name" style="font-weight: 600; color: #B9BBBE; font-size: 0.875rem; margin-bottom: 0.25rem;">${escapeHtml(field.name)}</div>
                                                <div class="embed-field-value" style="color: #DCDDDE; font-size: 0.875rem;">${escapeHtml(field.value)}</div>
                                            </div>
                                        `).join('')}
                                    </div>
                                ` : ''}
                                ${embed.footer ? `<div class="embed-footer" style="color: #72767D; font-size: 0.75rem; margin-top: 0.5rem;">${escapeHtml(embed.footer.text || embed.footer)}</div>` : ''}
                                ${embed.image ? `<img src="${escapeHtml(embed.image.url || embed.image)}" style="max-width: 100%; border-radius: 4px; margin-top: 0.5rem;" alt="Embed image">` : ''}
                            </div>
                        `).join('') : ''}
                        ${msg.has_media ? `
                            <div class="discord-media-preview" id="media-preview-${msg.id}" data-message-id="${msg.id}" data-media-url="${escapeHtml(msg.media_url || '')}" data-media-type="${escapeHtml(msg.media_type || '')}">
                                <div class="media-loading">Loading media...</div>
                            </div>
                        ` : ''}
                        ${msg.media_url && !msg.has_media ? `
                            <div class="discord-attachment" style="margin-top: 0.5rem;">
                                <img src="${escapeHtml(msg.media_url)}" style="max-width: 400px; border-radius: 4px;" alt="Discord attachment" loading="lazy" onerror="this.style.display='none'">
                            </div>
                        ` : ''}
                        <div style="display: flex; gap: 0.75rem; align-items: flex-start; margin-top: 0.5rem;">
                            <label style="display: flex; align-items: center; gap: 0.375rem; cursor: pointer;">
                                <input type="checkbox" class="message-export-checkbox message-checkbox" data-message-id="${msg.id}" data-bridge-id="${bridgeId}" style="width: 16px; height: 16px; cursor: pointer; accent-color: #a855f7;">
                                <span style="font-size: 0.75rem; color: #94a3b8;">Export</span>
                            </label>
                            <div class="message-drop-section" style="flex: 1;" data-message-id="${msg.id}" data-bridge-id="${bridgeId}">
                                <div class="drop-display hidden"></div>
                                <div class="drop-input-container">
                                    <input type="text" class="drop-input" placeholder="#FromDad Christmas 2021" data-message-id="${msg.id}">
                                    <button class="drop-save-btn" data-action="save-drop" data-message-id="${msg.id}" data-bridge-id="${bridgeId}" style="margin-top: 0.5rem;">Save</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
                }).join('');
                
                return bucketHeader + messagesHtml;
            }).join('');
            
            return html;
        }

        // Universal Search - searches both message content AND drops metadata
        async function filterDiscordMessages(bridgeId) {
            const searchText = document.getElementById(`msg-search-${bridgeId}`)?.value || '';
            const statusFilter = document.getElementById(`status-filter-${bridgeId}`)?.value || 'all';
            const messages = document.querySelectorAll(`#discord-messages-${bridgeId} .discord-message`);
            
            let dropsMatches = new Set();
            
            // If there's a search query, also search drops metadata
            if (searchText.trim()) {
                try {
                    const response = await authFetch(`/api/drops/search/${bridgeId}?q=${encodeURIComponent(searchText)}`);
                    if (response.ok) {
                        const drops = await response.json();
                        // Add all matching message IDs to the set
                        drops.forEach(drop => dropsMatches.add(drop.discord_message_id));
                        console.log(`🔍 Found ${drops.length} drops matching "${searchText}"`);
                    }
                } catch (err) {
                    console.log('Drop search skipped:', err.message);
                }
            }
            
            messages.forEach(msg => {
                const msgText = msg.getAttribute('data-search-text') || '';
                const msgStatus = msg.getAttribute('data-status') || '';
                const msgId = msg.getAttribute('data-msg-id') || '';
                
                // Match if: (message content matches OR drops metadata matches) AND status matches
                const matchesMessageContent = window.searchState.performSearch(searchText, msgText);
                const matchesDrops = dropsMatches.has(msgId);
                const matchesSearch = matchesMessageContent || matchesDrops;
                const matchesStatus = statusFilter === 'all' || msgStatus === statusFilter;
                
                msg.style.display = (matchesSearch && matchesStatus) ? 'flex' : 'none';
                
                // Highlight messages that matched via drops
                if (matchesDrops && !matchesMessageContent) {
                    msg.style.borderLeft = '3px solid rgba(167, 139, 250, 0.6)';
                } else {
                    msg.style.borderLeft = '';
                }
            });
        }

        // SEAMLESS SEARCH: Clear bridge search filter and hide indicator
        function clearBridgeSearchFilter(bridgeId) {
            // Clear the search box
            const searchBox = document.getElementById(`msg-search-${bridgeId}`);
            if (searchBox) {
                searchBox.value = '';
            }
            
            // Hide the indicator
            const indicator = document.getElementById(`search-indicator-${bridgeId}`);
            if (indicator) {
                indicator.style.display = 'none';
            }
            
            // Clear the search context
            bridgeSearchContext = { query: '', bridgeId: null };
            
            // Re-filter to show all messages
            filterDiscordMessages(bridgeId);
        }

        function renderMessages(data, bridgeId) {
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
                            <input type="text" id="msg-filter-${bridgeId}" placeholder="🔍 Filter messages..." style="padding: 0.5rem; background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0;" data-filter-table="${bridgeId}">
                            <select id="status-filter-${bridgeId}" data-status-filter="${bridgeId}" style="padding: 0.5rem; background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.375rem; color: #e2e8f0;">
                                <option value="all">All Status</option>
                                <option value="success">Success</option>
                                <option value="failed">Failed</option>
                                <option value="pending">Pending</option>
                            </select>
                        </div>
                        <span style="color: #94a3b8; font-size: 0.875rem;">Total: ${total} messages</span>
                    </div>

                    <table class="message-table" id="msg-table-${bridgeId}">
                        <thead>
                            <tr>
                                <th style="text-align: center; width: 50px;">
                                    <input type="checkbox" id="select-all-${bridgeId}" title="Select all messages">
                                </th>
                                <th data-bridge-id="${bridgeId}" data-sort-column="timestamp" style="min-width: 200px;">
                                    Timestamp<span class="sort-icon">↕</span>
                                </th>
                                <th data-bridge-id="${bridgeId}" data-sort-column="contact" style="min-width: 180px;">
                                    Contact / Phone<span class="sort-icon">↕</span>
                                </th>
                                <th data-bridge-id="${bridgeId}" data-sort-column="message">
                                    Message<span class="sort-icon">↕</span>
                                </th>
                                <th style="text-align: center; width: 100px;">Status</th>
                                <th style="text-align: center; width: 100px;">Attachments</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${messages.map((msg, index) => `
                                <tr data-timestamp="${msg.timestamp}" data-contact="${escapeHtml(msg.sender_contact || '')}" data-message="${escapeHtml(msg.message_content)}" data-status="${msg.discord_status}" data-msg-id="${msg.id}">
                                    <td style="text-align: center;">
                                        <input type="checkbox" class="message-checkbox" data-msg-id="${msg.id}" data-bridge-id="${bridgeId}">
                                    </td>
                                    <td class="timestamp-col">${formatTimestampWithTZ(msg.timestamp)}</td>
                                    <td class="contact-col">
                                        <div style="font-weight: 600;">${escapeHtml(msg.sender_name || 'Unknown')}</div>
                                        <div style="color: #94a3b8; font-size: 0.75rem;">${formatPhoneNumber(msg.sender_contact)}</div>
                                    </td>
                                    <td class="message-col">${escapeHtml(msg.message_content)}</td>
                                    <td style="text-align: center;">
                                        <span class="status-badge status-${msg.discord_status}">
                                            ${escapeHtml(msg.discord_status.toUpperCase())}
                                        </span>
                                    </td>
                                    <td class="attachment-col">
                                        ${msg.has_media ? `
                                            <span class="attachment-icon" data-message-id="${msg.id}" title="${escapeHtml(msg.media_type || 'Media')}">
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
                            <button class="btn" ${page <= 1 ? 'disabled' : ''} data-bridge-id="${bridgeId}" data-load-page="${page - 1}" style="padding: 0.375rem 0.75rem;">← Prev</button>
                            <span style="color: #94a3b8; font-size: 0.875rem;">Page ${page} / ${totalPages}</span>
                            <button class="btn" ${page >= totalPages ? 'disabled' : ''} data-bridge-id="${bridgeId}" data-load-page="${page + 1}" style="padding: 0.375rem 0.75rem;">Next →</button>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        // Sort messages table by column
        let messageSortState = {};
        function sortMessagesTable(bridgeId, column) {
            if (!messageSortState[bridgeId]) messageSortState[bridgeId] = {};
            const table = document.getElementById(`msg-table-${bridgeId}`);
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            
            // Toggle sort direction
            const currentDir = messageSortState[bridgeId][column] || 'asc';
            const newDir = currentDir === 'asc' ? 'desc' : 'asc';
            messageSortState[bridgeId] = { [column]: newDir };
            
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
        function filterMessagesTable(bridgeId) {
            const textFilter = document.getElementById(`msg-filter-${bridgeId}`).value;
            const statusFilter = document.getElementById(`status-filter-${bridgeId}`).value;
            const table = document.getElementById(`msg-table-${bridgeId}`);
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
                const response = await authFetch(`/api/messages/${messageId}/media`);
                if (!response.ok) {
                    alert('Media not available');
                    return;
                }
                
                const data = await response.json();
                const modal = document.getElementById('mediaModal');
                const modalContent = document.getElementById('mediaModalContent');
                const modalCaption = document.getElementById('mediaModalCaption');
                
                modalCaption.textContent = `${data.sender_name || 'Unknown'} - ${data.media_type || 'Media'}`;
                
                // Handle both simple types ("image") and MIME types ("image/jpeg")
                const mediaType = (data.media_type || '').toLowerCase();
                if (mediaType.includes('image')) {
                    modalContent.innerHTML = `<img src="${data.media_data}" alt="Media Preview">`;
                } else if (mediaType.includes('video')) {
                    modalContent.innerHTML = `<video controls autoplay><source src="${data.media_data}" type="${data.media_type}"></video>`;
                } else if (mediaType.includes('audio')) {
                    modalContent.innerHTML = `<audio controls autoplay><source src="${data.media_data}" type="${data.media_type}"></audio>`;
                } else {
                    modalContent.innerHTML = `<div style="color: white; padding: 2rem;">Preview not available for ${data.media_type}</div>`;
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
            document.getElementById('mediaModalContent').innerHTML = '';
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

        // UNIVERSAL SEARCH: Extract searchable text from bridge's cached messages
        // SECURITY: bridgeId MUST be fractal_id to maintain tenant isolation
        function getMessageSearchText(bridgeId) {
            // SECURITY: Validate fractal_id format before cache access
            if (!bridgeId || !/^(dev|prod)_bridge_t\d+_[a-f0-9]+$/.test(bridgeId)) {
                console.error('🚨 SECURITY: Attempted cache access with invalid bridge ID');
                return '';
            }
            
            const messages = messageCache[bridgeId];
            if (!messages || !Array.isArray(messages)) return '';
            
            // Extract all searchable content from messages (matching Discord message search)
            return messages.map(msg => {
                const parts = [
                    msg.sender_name || '',
                    msg.message_content || '',
                    msg.sender_contact || '',
                    extractEmbedSearchText(msg.embeds)
                ];
                return parts.join(' ');
            }).join(' ').toLowerCase();
        }

        function filterBots() {
            const searchTerm = document.getElementById('searchBox').value;
            const platformFilter = document.getElementById('platformFilter').value;
            const messageTypeFilter = document.getElementById('messageTypeFilter')?.value || '';
            
            // Parse natural language dates from search query
            const naturalDateRange = parseNaturalLanguageDate(searchTerm);
            const contextBadge = document.getElementById('searchContextBadge');
            
            if (naturalDateRange) {
                // Show context badge
                contextBadge.textContent = `📅 ${naturalDateRange.context}`;
                contextBadge.style.display = 'block';
                window.searchState.dateContext = naturalDateRange;
                console.log('🔍 Natural language date detected:', naturalDateRange);
            } else {
                // Hide context badge
                contextBadge.style.display = 'none';
                window.searchState.dateContext = null;
            }
            
            filteredBridges = bridges.filter(bridge => {
                // Search match using universal search function
                let matchesSearch = true;
                let matchType = null; // Track where match came from
                
                if (searchTerm && !naturalDateRange) {
                    // Only filter by text if NOT a pure date search
                    // COMPREHENSIVE: Search ALL bridge fields (matching Discord message search strength)
                    const bridgeMetadata = [
                        bridge.bridge_name || bridge.name || '',        // ✅ Bridge title
                        bridge.input_platform || '',                    // ✅ Input platform
                        bridge.output_platform || '',                   // ✅ Output platform
                        bridge.contact_info || '',                      // ✅ Contact info
                        bridge.status || '',                            // ✅ Status
                        bridge.created_at ? new Date(bridge.created_at).toLocaleString() : '', // ✅ Creation date
                        ...(bridge.tags || [])                          // ✅ Tags
                    ].join(' ').toLowerCase();
                    
                    // UNIVERSAL SEARCH: Check bridge metadata first
                    const matchesMetadata = window.searchState.performSearch(searchTerm, bridgeMetadata);
                    
                    // UNIVERSAL SEARCH: Check cached messages if metadata doesn't match
                    let matchesMessages = false;
                    if (!matchesMetadata && messageCache[bridge.fractal_id]) {
                        const messageText = getMessageSearchText(bridge.fractal_id);
                        matchesMessages = window.searchState.performSearch(searchTerm, messageText);
                    }
                    
                    matchesSearch = matchesMetadata || matchesMessages;
                    
                    // Store match type for visual indicator
                    if (matchesMessages) {
                        bridge._matchType = 'message';
                        // SEAMLESS SEARCH: Store query for auto-filtering when bridge is opened
                        bridge._searchQuery = searchTerm;
                    } else if (matchesMetadata) {
                        bridge._matchType = 'metadata';
                    }
                }
                
                const matchesPlatform = !platformFilter || bridge.input_platform === platformFilter;
                
                return matchesSearch && matchesPlatform;
            });
            
            renderBridges();
        }

        function updatePlatformFilter() {
            const platforms = [...new Set(bridges.map(bridge => bridge.input_platform))];
            const filter = document.getElementById('platformFilter');
            filter.innerHTML = '<option value="">All Platforms</option>' + 
                platforms.map(p => `<option value="${p}">${p}</option>`).join('');
        }

        // QR-FIRST ARCHITECTURE: Open in-page modal (no popup window friction)
        let currentBridgeFractalId = null;
        let bridgeStatusPollInterval = null;
        
        function openCreatePopup() {
            // Reset modal state
            document.getElementById('bridge-form-section').style.display = 'block';
            document.getElementById('bridge-qr-section').style.display = 'none';
            document.getElementById('bridge-create-form').reset();
            currentBridgeFractalId = null;
            
            // Show modal
            document.getElementById('createBridgeModal').classList.add('active');
        }
        
        function closeCreateBridgeModal() {
            document.getElementById('createBridgeModal').classList.remove('active');
            if (bridgeStatusPollInterval) {
                clearInterval(bridgeStatusPollInterval);
                bridgeStatusPollInterval = null;
            }
            // Reload bridges to show any newly created bridges
            loadBridges();
        }
        
        function copyBridgeFractalId() {
            if (currentBridgeFractalId) {
                navigator.clipboard.writeText(currentBridgeFractalId).then(() => {
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
        
        // Handle bridge creation form submission
        document.addEventListener('DOMContentLoaded', function() {
            const bridgeForm = document.getElementById('bridge-create-form');
            if (bridgeForm) {
                bridgeForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    
                    const bridgeName = document.getElementById('bridge-name-input').value;
                    const platform = document.getElementById('bridge-platform-input').value;
                    const userOutput = document.getElementById('bridge-output-input').value;
                    
                    const submitBtn = bridgeForm.querySelector('button[type="submit"]');
                    const originalText = submitBtn.textContent;
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<span class="bridge-loading"></span> Creating bridge...';
                    
                    try {
                        const token = localStorage.getItem('accessToken');
                        if (!token) {
                            throw new Error('Not authenticated. Please login first.');
                        }
                        
                        // 1. CREATE BRIDGE
                        console.log('📝 Creating bridge:', bridgeName);
                        const createRes = await fetch('/api/bridges', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`
                            },
                            body: JSON.stringify({
                                name: bridgeName,
                                inputPlatform: platform,
                                userOutputUrl: userOutput || null
                            })
                        });
                        
                        if (!createRes.ok) {
                            const error = await createRes.json();
                            throw new Error(error.error || 'Failed to create bridge');
                        }
                        
                        const bridge = await createRes.json();
                        console.log('✅ Bridge created:', bridge);
                        
                        if (!bridge.fractal_id) {
                            throw new Error('No fractal_id returned from server');
                        }
                        
                        // Store fractal_id globally and in localStorage for recovery
                        currentBridgeFractalId = bridge.fractal_id;
                        const recentBridges = JSON.parse(localStorage.getItem('recentBridges') || '[]');
                        recentBridges.unshift({
                            fractal_id: bridge.fractal_id,
                            name: bridgeName,
                            created_at: new Date().toISOString()
                        });
                        localStorage.setItem('recentBridges', JSON.stringify(recentBridges.slice(0, 10)));
                        
                        // 2. START WHATSAPP SESSION + GET QR
                        console.log('🚀 Starting WhatsApp session...');
                        const startRes = await fetch(`/api/bridges/${bridge.fractal_id}/start`, {
                            method: 'POST',
                            headers: { 
                                'Authorization': `Bearer ${token}`
                            }
                        });
                        
                        if (!startRes.ok) {
                            const error = await startRes.json();
                            throw new Error(error.error || 'Failed to start WhatsApp session');
                        }
                        
                        const startData = await startRes.json();
                        console.log('📱 WhatsApp session started:', startData);
                        
                        // 3. SHOW QR CODE IN CREATE BRIDGE MODAL
                        if (startData.qrCode) {
                            document.getElementById('bridge-qr-img').src = startData.qrCode;
                        } else {
                            // Fallback: fetch QR from separate endpoint (returns JSON)
                            const qrRes = await fetch(`/api/bridges/${bridge.fractal_id}/qr`, {
                                headers: { 
                                    'Authorization': `Bearer ${token}`
                                }
                            });
                            if (qrRes.ok) {
                                const qrData = await qrRes.json();
                                if (qrData.qr) {
                                    document.getElementById('bridge-qr-img').src = qrData.qr;
                                }
                            }
                        }
                        
                        document.getElementById('bridge-name-display').textContent = bridgeName;
                        document.getElementById('bridge-fractal-id').textContent = bridge.fractal_id;
                        document.getElementById('bridge-form-section').style.display = 'none';
                        document.getElementById('bridge-qr-section').style.display = 'block';
                        
                        // 4. POLL STATUS → AUTO-CLOSE ON SUCCESS
                        console.log('🔄 Polling for connection status...');
                        let pollInterval = setInterval(async () => {
                            try {
                                const statusRes = await fetch(`/api/bridges/${bridge.fractal_id}/qr`, {
                                    headers: { 
                                        'Authorization': `Bearer ${token}`
                                    }
                                });
                                
                                if (statusRes.ok) {
                                    const status = await statusRes.json();
                                    console.log('📊 Status:', status);
                                    
                                    // Close modal when WhatsApp connects
                                    if (status.status === 'ready' || status.status === 'connected' || status.status === 'active' || status.status === 'authenticated') {
                                        clearInterval(pollInterval);
                                        document.querySelector('.bridge-qr-status').innerHTML = '✅ Connected! Closing...';
                                        document.querySelector('.bridge-qr-status').style.background = 'rgba(34, 197, 94, 0.2)';
                                        document.querySelector('.bridge-qr-status').style.borderColor = 'rgba(34, 197, 94, 0.3)';
                                        document.querySelector('.bridge-qr-status').style.color = '#22c55e';
                                        setTimeout(() => {
                                            closeCreateBridgeModal();
                                            loadBridges();
                                        }, 1500);
                                    }
                                }
                            } catch (pollError) {
                                console.error('Poll error:', pollError);
                            }
                        }, 2000);
                        
                        submitBtn.disabled = false;
                        submitBtn.textContent = originalText;
                        
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
            if (bridges.length === 0 || !localStorage.getItem('skipQuickStart')) {
                openQuickStartWizard();
                return;
            }
            
            editingBridgeId = null;
            document.getElementById('modalTitle').textContent = 'Create New Bridge';
            document.getElementById('botForm').reset();
            botTags = [];
            botWebhooks = [];
            renderTags();
            renderWebhooks();
            document.getElementById('botModal').classList.add('active');
        }

        function editBridge(fractalId) {
            // Find bridge by fractal_id (hash string like "dev_bridge_t9_54ab7617ffeb")
            const bridge = bridges.find(b => b.fractal_id === fractalId);
            if (!bridge) {
                console.error('Bridge not found:', fractalId, 'Available bridges:', bridges.map(b => b.fractal_id));
                return;
            }
            
            editingBridgeId = fractalId;
            document.getElementById('modalTitle').textContent = 'Edit Bridge';
            document.getElementById('botName').value = bridge.name || '';
            document.getElementById('botPlatform').value = bridge.input_platform;
            document.getElementById('botDestinationPlatform').value = bridge.output_platform;
            document.getElementById('botContact').value = bridge.contact_info || '';
            botTags = bridge.tags || [];
            
            // Load webhooks from output_01_url and output_0n_url
            botWebhooks = [];
            if (bridge.output_0n_url) {
                botWebhooks.push({
                    id: Date.now(),
                    name: 'User Discord',
                    url: bridge.output_0n_url
                });
            }
            
            renderTags();
            renderWebhooks();
            document.getElementById('botModal').classList.add('active');
        }

        function closeBotModal() {
            document.getElementById('botModal').classList.remove('active');
            document.getElementById('botName').value = '';
            editingBridgeId = null;
            botTags = [];
            botWebhooks = [];
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
            editingBridgeId = null;
            document.getElementById('modalTitle').textContent = 'Create New Bridge';
            document.getElementById('botForm').reset();
            botTags = [];
            botWebhooks = [];
            renderTags();
            renderWebhooks();
            document.getElementById('botModal').classList.add('active');
        }

        function startBridgeSetup() {
            closeQuickStartWizard();
            // Open regular create modal with a hint banner
            editingBridgeId = null;
            document.getElementById('modalTitle').textContent = 'Create New Bridge';
            document.getElementById('botForm').reset();
            botTags = [];
            botWebhooks = [];
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
            banner.innerHTML = '<strong>🎯 Step 1:</strong> Fill in the platform details below → <strong>Step 2:</strong> QR code will appear after saving → <strong>Step 3:</strong> Add your Discord webhook';
            form.insertBefore(banner, form.firstChild);
        }

        async function saveBotClicked(event) {
            event.preventDefault();
            
            const bridgeName = document.getElementById('botName').value;
            const inputPlatform = document.getElementById('botPlatform').value;
            const outputPlatform = document.getElementById('botDestinationPlatform').value;
            const contact = document.getElementById('botContact').value;
            
            // Filter out empty webhooks
            const validWebhooks = botWebhooks.filter(w => w.url && w.url.trim());
            
            // Prepare output credentials with webhooks
            const outputCredentials = {
                webhooks: validWebhooks.map(w => ({ name: w.name, url: w.url }))
            };
            
            // If no webhooks provided, add a placeholder entry
            if (validWebhooks.length === 0 && outputPlatform === 'Discord') {
                outputCredentials.webhooks = [{ 
                    name: 'Main Channel', 
                    url: '' 
                }];
            }
            
            const botData = {
                name: bridgeName || `${inputPlatform} → ${outputPlatform} Bridge`,
                inputPlatform: inputPlatform,
                outputPlatform: outputPlatform,
                inputCredentials: {},
                outputCredentials: outputCredentials,
                contactInfo: contact,
                tags: botTags,
                status: 'active'
            };

            try {
                const url = editingBridgeId ? `/api/bridges/${editingBridgeId}` : '/api/bridges';
                const method = editingBridgeId ? 'PUT' : 'POST';
                
                const response = await authFetch(url, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(botData)
                });

                if (response.ok) {
                    closeBotModal();
                    loadBridges();
                    alert('✅ Bot created successfully! Click the ▶️ button to start WhatsApp.');
                } else {
                    const errorData = await response.json().catch(() => ({}));
                    alert(`Failed to save bot: ${errorData.error || response.statusText}`);
                }
            } catch (error) {
                console.error('Error saving bot:', error);
                alert(`Error saving bot: ${error.message}`);
            }
        }


        // UNIFIED QR DISPLAY: Single function for both create & relink flows
        async function showQRAndWaitForConnection(bridgeId, bridgeName) {
            console.log(`🔄 Showing QR for bridge: ${bridgeName} (${bridgeId})`);
            
            // Open modal immediately with loading state
            const modal = document.getElementById('qrModal');
            const qrImage = document.getElementById('qrCodeImage');
            const loadingMsg = document.getElementById('qrLoadingMessage');
            const errorMsg = document.getElementById('qrErrorMessage');
            const instructions = document.getElementById('qrInstructions');
            const modalTitle = document.getElementById('qrModalTitle');
            
            // Reset modal state
            qrImage.style.display = 'none';
            loadingMsg.style.display = 'flex';
            errorMsg.style.display = 'none';
            instructions.style.display = 'none';
            modalTitle.textContent = '📱 Generating QR Code...';
            modal.style.display = 'flex';
            
            try {
                // Poll for QR code (max 15 seconds)
                let attempts = 0;
                const maxAttempts = 30; // 30 attempts * 500ms = 15 seconds
                
                const pollQR = async () => {
                    attempts++;
                    
                    const qrResponse = await authFetch(`/api/bridges/${bridgeId}/qr`);
                    if (!qrResponse.ok) {
                        showQRError('Server Error', 'Failed to fetch QR code. Please try again.');
                        return;
                    }
                    
                    const data = await qrResponse.json();
                    console.log(`QR Poll attempt ${attempts}:`, data);
                    
                    if (data.qr) {
                        // QR code is ready!
                        loadingMsg.style.display = 'none';
                        qrImage.src = data.qr;
                        qrImage.style.display = 'block';
                        instructions.style.display = 'block';
                        modalTitle.textContent = `📱 Scan QR Code: ${bridgeName}`;
                        
                        // Start watching for connection (unified watcher for all states)
                        startQRWatcher(bridgeId);
                    } else if (data.status === 'connected' || data.status === 'ready' || data.status === 'active') {
                        showQRError('✅ Already Connected!', 'Your WhatsApp is already connected.', true);
                        setTimeout(() => {
                            closeQRModal();
                            renderBridges();
                        }, 2000);
                    } else if (attempts < maxAttempts) {
                        // Keep polling
                        setTimeout(pollQR, 500);
                    } else {
                        // Timeout
                        showQRError('⏱️ Timeout', 'QR code generation took too long. Please refresh and try again.');
                    }
                };
                
                // Start polling after brief delay
                setTimeout(pollQR, 1000);
                
            } catch (error) {
                console.error('Error showing QR:', error);
                showQRError('❌ Connection Error', error.message || 'Unknown error occurred.');
            }
        }
        
        // Generate new QR - wrapper for unified function
        async function generateNewQR(bridgeId) {
            // Get bridge name from bridges list
            const bridge = bridges.find(b => b.fractal_id === bridgeId);
            const bridgeName = bridge?.name || 'Bridge';
            
            // Relink first to get fresh QR
            try {
                const relinkResponse = await authFetch(`/api/bridges/${bridgeId}/relink`, {
                    method: 'POST'
                });
                
                if (!relinkResponse.ok) {
                    const error = await relinkResponse.json();
                    alert(`Failed to relink: ${error.error}`);
                    return;
                }
                
                // CRITICAL FIX: Poll for client readiness after relink
                // Relink destroys and recreates the client, need to wait for initialization
                console.log('⏳ Waiting for Baileys client to initialize after relink...');
                
                let attempts = 0;
                const maxAttempts = 15; // 15 attempts * 500ms = 7.5 seconds max
                
                while (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    attempts++;
                    
                    const statusCheck = await authFetch(`/api/bridges/${bridgeId}/qr`);
                    if (statusCheck.ok) {
                        const data = await statusCheck.json();
                        
                        // Client is ready if it has a QR or is already connected
                        if (data.qr || data.status === 'qr_ready' || data.status === 'connected' || data.status === 'active') {
                            console.log(`✅ Baileys client ready after ${attempts * 500}ms`);
                            break;
                        }
                    }
                    
                    // Continue polling...
                    console.log(`⏳ Client not ready yet (attempt ${attempts}/${maxAttempts})...`);
                }
                
                if (attempts >= maxAttempts) {
                    alert('⏱️ Timeout: WhatsApp client took too long to initialize. Please try again.');
                    return;
                }
                
                // Show unified QR modal
                showQRAndWaitForConnection(bridgeId, bridgeName);
            } catch (error) {
                console.error('Error relinking:', error);
                alert(`Error: ${error.message}`);
            }
        }
        
        function showQRError(title, message, isSuccess = false) {
            const loadingMsg = document.getElementById('qrLoadingMessage');
            const errorMsg = document.getElementById('qrErrorMessage');
            const modalTitle = document.getElementById('qrModalTitle');
            
            loadingMsg.style.display = 'none';
            errorMsg.style.display = 'block';
            modalTitle.textContent = title;
            
            const bgColor = isSuccess ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
            const borderColor = isSuccess ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)';
            
            errorMsg.innerHTML = `
                <div style="background: ${bgColor}; border: 1px solid ${borderColor}; border-radius: 12px; padding: 1.5rem;">
                    <p style="margin: 0; color: rgba(255, 255, 255, 0.9); font-size: 1rem; line-height: 1.6;">
                        ${message}
                    </p>
                </div>
            `;
        }

        // Global QR watcher interval tracker
        let qrWatcherInterval = null;
        
        // Watch for QR code disappearance (means user successfully scanned)
        function startQRWatcher(bridgeId) {
            // Clear any existing watcher
            if (qrWatcherInterval) {
                clearInterval(qrWatcherInterval);
            }
            
            let attempts = 0;
            const maxAttempts = 120; // Watch for up to 2 minutes
            
            qrWatcherInterval = setInterval(async () => {
                attempts++;
                
                try {
                    // Check if QR still exists
                    const qrResponse = await authFetch(`/api/bridges/${bridgeId}/qr`);
                    if (!qrResponse.ok) {
                        console.log('Failed to fetch QR during watch');
                        return;
                    }
                    
                    const data = await qrResponse.json();
                    console.log(`QR watch attempt ${attempts}:`, data.qr ? 'QR exists' : 'No QR (scanned!)', `status: ${data.status}`);
                    
                    // UNIFIED: Check for all success states (authenticated, connected, ready, active)
                    if (!data.qr && (data.status === 'authenticated' || data.status === 'connected' || data.status === 'ready' || data.status === 'active')) {
                        console.log(`✅ WhatsApp ${data.status}! Auto-closing modal...`);
                        clearInterval(qrWatcherInterval);
                        qrWatcherInterval = null;
                        
                        const qrContainer = document.getElementById('qrCodeContainer');
                        qrContainer.innerHTML = `
                            <div style="text-align: center;">
                                <div style="font-size: 5rem; margin-bottom: 1rem;">🎉</div>
                                <p style="color: rgba(16, 185, 129, 1); font-size: 1.5rem; font-weight: bold; margin: 0;">
                                    Connected Successfully!
                                </p>
                                <p style="color: rgba(255, 255, 255, 0.8); font-size: 1rem; margin-top: 0.5rem;">
                                    Closing in 1.5 seconds...
                                </p>
                            </div>
                        `;
                        
                        setTimeout(() => {
                            closeQRModal();
                            renderBridges();
                        }, 1500);
                    } else if (attempts >= maxAttempts) {
                        // Timeout
                        clearInterval(qrWatcherInterval);
                        qrWatcherInterval = null;
                        console.log('QR watcher timeout - stopped after 2 minutes');
                    }
                } catch (error) {
                    console.error('Error during QR watch:', error);
                }
            }, 1000); // Check every 1 second
        }
        
        function closeQRModal() {
            // Stop watcher when modal closes
            if (qrWatcherInterval) {
                clearInterval(qrWatcherInterval);
                qrWatcherInterval = null;
            }
            document.getElementById('qrModal').style.display = 'none';
        }

        // Start WhatsApp session for a bot
        async function startWhatsApp(bridgeId) {
            try {
                console.log('Starting WhatsApp for bridge:', bridgeId);
                const response = await authFetch(`/api/bridges/${bridgeId}/start`, {
                    method: 'POST'
                });
                
                if (response.ok) {
                    const data = await response.json();
                    alert('✅ WhatsApp Starting!\n\n📱 QR code is being generated automatically...\n\n⏳ Next Steps:\n1. Wait 5-10 seconds\n2. Click the 📱 QR button\n3. Scan with your phone\n4. Done!');
                    
                    // Auto-refresh after 3 seconds to update status
                    setTimeout(() => {
                        renderBridges();
                    }, 3000);
                } else {
                    const error = await response.json();
                    alert(`Failed to start WhatsApp: ${error.error || 'Unknown error'}`);
                }
            } catch (error) {
                console.error('Error starting WhatsApp:', error);
                alert(`Error starting WhatsApp: ${error.message}`);
            }
        }

        // Stop WhatsApp session for a bridge (preserves session)
        async function stopWhatsApp(bridgeId) {
            if (!confirm('Stop WhatsApp session? You can restart it later without scanning a new QR code.')) {
                return;
            }
            
            try {
                console.log('Stopping WhatsApp for bridge:', bridgeId);
                const response = await authFetch(`/api/bridges/${bridgeId}/stop`, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    alert('✅ WhatsApp session stopped (session preserved)');
                    renderBridges();
                } else {
                    const error = await response.json();
                    alert(`Failed to stop WhatsApp: ${error.error || 'Unknown error'}`);
                }
            } catch (error) {
                console.error('Error stopping WhatsApp:', error);
                alert(`Error stopping WhatsApp: ${error.message}`);
            }
        }

        // Relink WhatsApp (get fresh QR code)
        async function relinkWhatsApp(bridgeId) {
            if (!confirm('Relink WhatsApp? This will generate a new QR code and you\'ll need to scan it again.')) {
                return;
            }
            
            try {
                console.log('Relinking WhatsApp for bridge:', bridgeId);
                const response = await authFetch(`/api/bridges/${bridgeId}/relink`, {
                    method: 'POST'
                });
                
                if (response.ok) {
                    const data = await response.json();
                    alert('✅ Relink initiated! Refresh the page in a moment to see the new QR code.');
                    
                    // Auto-refresh after 2 seconds
                    setTimeout(() => {
                        renderBridges();
                    }, 2000);
                } else {
                    const error = await response.json();
                    alert(`Failed to relink WhatsApp: ${error.error || 'Unknown error'}`);
                }
            } catch (error) {
                console.error('Error relinking WhatsApp:', error);
                alert(`Error relinking WhatsApp: ${error.message}`);
            }
        }

        async function confirmDeleteBridge(fractalId) {
            // Find bridge by fractal_id (hash string)
            const bridge = bridges.find(b => b.fractal_id === fractalId);
            if (!bridge) {
                console.error(`Bridge ${fractalId} not found in bridges array`);
                return;
            }
            
            if (!confirm(`Are you sure you want to delete "${bridge.name || bridge.input_platform + ' → ' + bridge.output_platform}" bridge?\n\nAll messages will be preserved in Discord.`)) {
                return;
            }
            
            try {
                const response = await authFetch(`/api/bridges/${fractalId}`, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    // Animate bridge card deletion with liquid glass effect
                    const bridgeCard = document.querySelector(`.channel-item[data-bridge-id="${fractalId}"]`);
                    if (bridgeCard) {
                        // Apply liquid glass delete animation
                        bridgeCard.style.transition = 'all 0.6s cubic-bezier(0.4, 0.0, 0.2, 1)';
                        bridgeCard.style.transform = 'scale(0.95)';
                        bridgeCard.style.opacity = '0.7';
                        bridgeCard.style.filter = 'blur(4px)';
                        
                        // Second phase: shrink and fade out with glass effect
                        setTimeout(() => {
                            bridgeCard.style.transform = 'scale(0.85) translateX(-30px)';
                            bridgeCard.style.opacity = '0';
                            bridgeCard.style.filter = 'blur(15px)';
                            bridgeCard.style.maxHeight = '0';
                            bridgeCard.style.marginBottom = '0';
                            bridgeCard.style.paddingTop = '0';
                            bridgeCard.style.paddingBottom = '0';
                            bridgeCard.style.overflow = 'hidden';
                        }, 150);
                        
                        // Remove from DOM and update state after animation
                        setTimeout(() => {
                            bridgeCard.remove();
                            
                            // CRITICAL: Immediately remove from arrays to prevent loop-back
                            bridges = bridges.filter(b => b.fractal_id !== fractalId);
                            filteredBridges = filteredBridges.filter(b => b.fractal_id !== fractalId);
                            
                            // Clear selection and detail view if deleted bridge was selected
                            if (selectedBridgeId === fractalId) {
                                selectedBridgeId = null;
                                const detail = document.getElementById('bridgeDetail');
                                if (detail) {
                                    detail.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 2rem;">Select a bridge to view messages</p>';
                                }
                            }
                            
                            // Update bridge count in Bridges tab
                            updateBridgeCount();
                            
                            // Show success toast
                            showToast('✅ Bridge deleted successfully', 'success');
                            
                            // If no bridges left, show empty state
                            if (bridges.length === 0) {
                                const sidebar = document.getElementById('bridgeListContainer');
                                sidebar.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 2rem; font-size: 0.875rem;">No bridges found</p>';
                            }
                        }, 750);
                    } else {
                        // Fallback: reload if card not found
                        selectedBridgeId = null;
                        loadBridges();
                        showToast('✅ Bridge deleted successfully', 'success');
                    }
                } else {
                    const error = await response.json();
                    showToast(`❌ Failed to delete: ${error.error || 'Unknown error'}`, 'error');
                }
            } catch (error) {
                console.error('Error deleting bot:', error);
                showToast('❌ Error deleting bridge', 'error');
            }
        }
        
        // Export bridge data (messages + drops) as ZIP
        async function exportBridgeData(fractalId) {
            try {
                const bridge = bridges.find(b => b.fractal_id === fractalId);
                if (!bridge) {
                    showToast('❌ Bridge not found', 'error');
                    return;
                }
                
                // Get selected message IDs for this bridge
                const selectedIds = selectedMessages[fractalId] 
                    ? Array.from(selectedMessages[fractalId]) 
                    : [];
                
                console.log('📦 EXPORT FLOW START');
                console.log('📦 Bridge ID:', fractalId);
                console.log('📦 Bridge Name:', bridge.name);
                console.log('📦 Selected IDs:', selectedIds);
                console.log('📦 Selected Count:', selectedIds.length);
                
                if (selectedIds.length === 0) {
                    showToast('❌ Please select messages to export', 'error');
                    return;
                }
                
                showToast(`📦 Preparing export of ${selectedIds.length} message(s)...`, 'info');
                
                console.log('📦 Sending POST request to /api/bridges/' + fractalId + '/export');
                console.log('📦 Payload:', { messageIds: selectedIds });
                
                // Send selected message IDs to backend
                const response = await authFetch(`/api/bridges/${fractalId}/export`, {
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
                a.download = `${(bridge.name || 'bridge').replace(/[^a-z0-9]/gi, '_')}_export.zip`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                
                showToast('✅ Export downloaded successfully!', 'success');
                
            } catch (error) {
                console.error('Error exporting bridge data:', error);
                showToast('❌ Export failed', 'error');
            }
        }
        
        // Restore checkbox checked states after rendering
        function restoreCheckboxStates(bridgeId) {
            if (!selectedMessages[bridgeId]) return;
            
            selectedMessages[bridgeId].forEach(msgId => {
                const checkbox = document.querySelector(`input.message-export-checkbox[data-message-id="${msgId}"]`);
                if (checkbox) {
                    checkbox.checked = true;
                }
            });
        }
        
        // Update export button state based on selected messages
        function updateExportButtonState(bridgeId) {
            console.log(`🔄 updateExportButtonState called for bridge: ${bridgeId}`);
            const exportBtn = document.querySelector(`[data-export-bridge="${bridgeId}"]`);
            console.log(`🔍 Export button found:`, exportBtn ? 'YES' : 'NO');
            if (!exportBtn) {
                console.warn(`⚠️ Export button not found for bridge: ${bridgeId}`);
                return;
            }
            
            const count = selectedMessages[bridgeId] ? selectedMessages[bridgeId].size : 0;
            console.log(`📊 Selected count for ${bridgeId}: ${count}`);
            
            if (count > 0) {
                exportBtn.textContent = `📦 Export (${count})`;
                exportBtn.disabled = false;
                exportBtn.style.opacity = '1';
                console.log(`✅ Export button enabled with ${count} messages`);
            } else {
                exportBtn.textContent = '📦 Export';
                exportBtn.disabled = true;
                exportBtn.style.opacity = '0.5';
                console.log(`🔒 Export button disabled (no messages selected)`);
            }
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
        
        // Helper to update bridge count badge
        function updateBridgeCount() {
            const bridgeButton = document.querySelector('[onclick="showTab(\'bridges\')"]');
            if (bridgeButton) {
                const badge = bridgeButton.querySelector('.tab-badge');
                if (badge) {
                    badge.textContent = bridges.length;
                }
            }
        }

        window.onclick = function(event) {
            const qrModal = document.getElementById('qrModal');
            if (event.target === qrModal) {
                closeQRModal();
            }
        }

        async function toggleMessages(bridgeId) {
            console.log('Toggle messages for bridge:', bridgeId);
            
            const container = document.getElementById(`messages-${bridgeId}`);
            const button = document.getElementById(`toggle-btn-${bridgeId}`);
            
            if (expandedBots.has(bridgeId)) {
                // Collapse
                expandedBots.delete(bridgeId);
                container.style.display = 'none';
                button.innerHTML = '▼ Show Messages';
            } else {
                // Expand
                expandedBots.add(bridgeId);
                container.style.display = 'block';
                button.innerHTML = '▲ Hide Messages';
                
                // Load messages if not cached
                if (!messageCache[bridgeId]) {
                    await loadBridgeMessages(bridgeId, 1);
                }
            }
        }
        
        // Toggle between custom message view and Discord embed (DISCORD UI EMBEDDING)
        function toggleDiscordEmbed(bridgeId) {
            const messagesContainer = document.getElementById(`discord-messages-${bridgeId}`);
            const embedContainer = document.getElementById(`discord-embed-${bridgeId}`);
            const toggleButton = document.getElementById(`discord-toggle-${bridgeId}`);
            const searchContainer = document.querySelector(`#msg-search-${bridgeId}`)?.parentElement;
            
            if (embedContainer.style.display === 'none') {
                // Switch to Discord embed
                messagesContainer.style.display = 'none';
                embedContainer.style.display = 'block';
                toggleButton.innerHTML = '📋 Custom View';
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
                toggleButton.innerHTML = '🎭 Discord UI';
                toggleButton.title = 'View in Discord (native UI with full features)';
                if (searchContainer) {
                    const inputEl = searchContainer.querySelector('input');
                    const selectEl = searchContainer.querySelector('select');
                    if (inputEl) inputEl.style.display = 'block';
                    if (selectEl) selectEl.style.display = 'block';
                }
            }
        }
        
        async function loadBridgeMessages(bridgeId, page = 1) {
            try {
                // SECURITY: Validate bridgeId is a fractal_id (tenant-scoped, non-enumerable)
                // Format: dev_bridge_t{N}_{HASH} or prod_bridge_t{N}_{HASH}
                if (!bridgeId || !/^(dev|prod)_bridge_t\d+_[a-f0-9]+$/.test(bridgeId)) {
                    console.error('🚨 SECURITY: Invalid bridge ID format:', bridgeId);
                    throw new Error('Invalid bridge ID');
                }
                
                // SCHEMA SWITCHEROO: Use currentViewSource to pull from correct webhook
                console.log(`Loading messages for bridge ${bridgeId} (source: ${currentViewSource})...`);
                const response = await authFetch(`/api/bridges/${bridgeId}/messages?page=${page}&limit=50&source=${currentViewSource}`);
                
                if (!response.ok) {
                    console.error(`API returned ${response.status}: ${response.statusText}`);
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                console.log(`Received ${data.messages?.length || 0} messages:`, data);
                
                // SECURITY: Cache ONLY with tenant-scoped fractal_id
                // This ensures complete tenant isolation in message cache
                messageCache[bridgeId] = data.messages;
                
                // Re-render Discord-style messages
                const container = document.getElementById(`discord-messages-${bridgeId}`);
                console.log(`🎯 Container lookup: discord-messages-${bridgeId}`, container ? 'FOUND' : 'NOT FOUND');
                if (container) {
                    const html = renderDiscordMessages(data.messages, bridgeId);
                    console.log(`📝 Generated HTML length: ${html.length} chars`);
                    container.innerHTML = html;
                    console.log(`✅ Rendered ${data.messages?.length || 0} messages to container`);
                    
                    // Dynamically create export checkboxes AFTER HTML render
                    // This ensures they're truly interactive and separate from read-only message structure
                    restoreCheckboxStates(bridgeId);
                    
                    // Hydrate drops (Personal Cloud OS metadata)
                    hydrateDropsForBridge(bridgeId);
                    
                    // SEAMLESS SEARCH: Auto-populate and filter if bridge was opened from message search
                    if (bridgeSearchContext.query && bridgeSearchContext.bridgeId === bridgeId) {
                        const searchBox = document.getElementById(`msg-search-${bridgeId}`);
                        const indicator = document.getElementById(`search-indicator-${bridgeId}`);
                        if (searchBox) {
                            searchBox.value = bridgeSearchContext.query;
                            // Show visual indicator
                            if (indicator) {
                                indicator.style.display = 'flex';
                            }
                            // Auto-trigger filter with slight delay to ensure messages are in DOM
                            setTimeout(() => {
                                filterDiscordMessages(bridgeId);
                            }, 50);
                        }
                    }
                    
                    // Initialize media lazy loading for this bridge's messages
                    setTimeout(() => {
                        if (window.initMediaLazyLoading) {
                            window.initMediaLazyLoading();
                        }
                    }, 100);
                } else {
                    console.error(`❌ Container NOT FOUND: discord-messages-${bridgeId}`);
                }
            } catch (error) {
                console.error('Error loading messages:', error);
                const container = document.getElementById(`discord-messages-${bridgeId}`);
                if (container) {
                    container.innerHTML = '<div class="no-messages" style="color: #ef4444;">Error loading messages. Please try refreshing.</div>';
                }
            }
        }

        // Load and display inline media preview
        async function loadMediaPreview(messageId) {
            const previewContainer = document.getElementById(`media-preview-${messageId}`);
            if (!previewContainer) return;
            
            try {
                const response = await authFetch(`/api/messages/${messageId}/media`);
                if (!response.ok) {
                    previewContainer.innerHTML = '<div class="media-error">Media unavailable</div>';
                    return;
                }
                
                const data = await response.json();
                const mediaType = (data.media_type || '').toLowerCase();
                
                if (mediaType.includes('image')) {
                    // Image preview - click to enlarge
                    previewContainer.innerHTML = `
                        <img src="${data.media_data}" 
                             alt="Image attachment" 
                             class="discord-media-image"
                             data-message-id="${messageId}"
                             loading="lazy"
                             style="cursor: pointer;">
                    `;
                } else if (mediaType.includes('video')) {
                    // Inline video player
                    previewContainer.innerHTML = `
                        <video controls class="discord-media-video">
                            <source src="${data.media_data}" type="${data.media_type}">
                            Your browser doesn't support video playback.
                        </video>
                        <div class="media-expand-hint" data-message-id="${messageId}" style="cursor: pointer;">Click to view fullscreen</div>
                    `;
                } else if (mediaType.includes('audio')) {
                    // Inline audio player
                    previewContainer.innerHTML = `
                        <audio controls class="discord-media-audio">
                            <source src="${data.media_data}" type="${data.media_type}">
                            Your browser doesn't support audio playback.
                        </audio>
                    `;
                } else {
                    // Fallback for other types
                    previewContainer.innerHTML = `
                        <div class="discord-attachment" data-message-id="${messageId}" style="cursor: pointer;">
                            <span class="attachment-icon">📎</span>
                            <span class="attachment-type">${escapeHtml(data.media_type || 'Attachment')}</span>
                        </div>
                    `;
                }
            } catch (error) {
                console.error('Error loading media preview:', error);
                previewContainer.innerHTML = '<div class="media-error">Failed to load media</div>';
            }
        }

        // OLD User Management functions removed - replaced with loadAdminCards() and renderAdminUserManagement()
        // These are now defined below in the new architecture section

        function openCreateUserModal() {
            // Populate role dropdown based on creator's role (security: prevent privilege escalation)
            const roleSelect = document.getElementById('userRole');
            roleSelect.innerHTML = ''; // Clear existing options
            
            if (currentUser.role === 'dev') {
                // Dev can create any role
                roleSelect.innerHTML = `
                    <option value="dev">Dev (Full Access)</option>
                    <option value="admin">Admin (Tenant Manager)</option>
                    <option value="read-only" selected>Read-Only (View Only)</option>
                    <option value="write-only">Write-Only (Create/Edit)</option>
                `;
            } else if (currentUser.role === 'admin') {
                // Admin can only create read-only or write-only (NOT dev, NOT admin)
                roleSelect.innerHTML = `
                    <option value="read-only" selected>Read-Only (View Only)</option>
                    <option value="write-only">Write-Only (Create/Edit)</option>
                `;
            }
            
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
                const response = await authFetch('/api/users', {
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
                const response = await authFetch(`/api/users/${userId}`, {
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

        async function deleteUser(userId) {
            if (!confirm('Are you sure you want to delete this user?')) return;
            
            try {
                const response = await authFetch(`/api/users/${userId}`, { method: 'DELETE' });
                if (response.ok) {
                    loadAdminCards(); // Updated to use new function
                    loadDevPanelAdmins(); // Also refresh dev panel if visible
                } else {
                    alert('Failed to delete user');
                }
            } catch (error) {
                console.error('Error deleting user:', error);
            }
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
                const response = await authFetch(`/api/users/${userId}/email`, {
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
                const response = await authFetch(`/api/users/${userId}/password`, {
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
                
                const response = await authFetch(`/api/sessions?${params}`);
                if (!response.ok) {
                    throw new Error(`Failed to load sessions: ${response.status}`);
                }
                
                const data = await response.json();
                
                if (!data.sessions || data.sessions.length === 0) {
                    sessionsList.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 3rem;">No active sessions found. Sessions will appear here when users log in.</p>';
                    return;
                }
                
                sessionsList.innerHTML = data.sessions.map(session => {
                    const loginDate = new Date(session.login_time).toLocaleString();
                    const lastActivity = new Date(session.last_activity).toLocaleString();
                    const statusBadge = session.is_active 
                        ? '<span style="color: #10b981; font-weight: 600;">● Active</span>' 
                        : '<span style="color: #94a3b8;">○ Inactive</span>';
                    
                    return `
                        <div class="user-card" style="opacity: ${session.is_active ? '1' : '0.6'}">
                            <div class="user-info">
                                <div class="user-email">${escapeHtml(session.email || session.phone || 'Unknown User')}</div>
                                <div class="user-role">${statusBadge}</div>
                            </div>
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; margin-top: 0.75rem; font-size: 0.875rem; color: #cbd5e1;">
                                <div><strong>Device:</strong> ${escapeHtml(session.device_type || 'Unknown')}</div>
                                <div><strong>Browser:</strong> ${escapeHtml(session.browser || 'Unknown')}</div>
                                <div><strong>OS:</strong> ${escapeHtml(session.os || 'Unknown')}</div>
                                <div><strong>IP:</strong> ${escapeHtml(session.ip_address || 'Unknown')}</div>
                                <div><strong>Location:</strong> 🌍 ${escapeHtml(session.location || 'Unknown Location')}</div>
                                <div><strong>Login:</strong> ${loginDate}</div>
                                <div><strong>Last Activity:</strong> ${lastActivity}</div>
                            </div>
                            <div class="user-actions">
                                ${session.is_active ? `<button class="btn btn-delete" data-revoke-session="${session.id}">Revoke</button>` : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (error) {
                console.error('Error loading sessions:', error);
                if (sessionsList) {
                    sessionsList.innerHTML = '<div style="text-align: center; padding: 3rem; color: #ef4444;">Error loading sessions. Please try refreshing the page.</div>';
                }
            }
        }

        async function revokeSession(sessionId) {
            if (!confirm('Are you sure you want to revoke this session? The user will be logged out immediately.')) return;
            
            try {
                const response = await authFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
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
        }

        async function revokeAllSessions() {
            if (!confirm('⚠️ WARNING: This will revoke ALL active sessions except your current one. All other users will be logged out immediately. Are you sure?')) return;
            
            try {
                const response = await authFetch('/api/sessions/revoke-all', { 
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
        }

        // Load Dev Panel (dev role only)
        async function loadAdminPanel() {
            if (!currentUser || currentUser.role !== 'dev') {
                return;
            }

            // Load users
            try {
                const usersResponse = await authFetch('/api/users');
                if (usersResponse.ok) {
                    const users = await usersResponse.json();
                    renderAdminUsers(users);
                }
            } catch (error) {
                console.error('Error loading users for admin panel:', error);
                document.getElementById('adminUserList').innerHTML = '<div style="color: #ef4444; text-align: center; padding: 1rem;">Error loading users</div>';
            }

            // Load sessions
            try {
                const sessionsResponse = await authFetch('/api/sessions');
                if (sessionsResponse.ok) {
                    const sessions = await sessionsResponse.json();
                    renderAdminSessions(sessions);
                }
            } catch (error) {
                console.error('Error loading sessions for admin panel:', error);
                document.getElementById('adminSessionsList').innerHTML = '<div style="color: #ef4444; text-align: center; padding: 1rem;">Error loading sessions</div>';
            }

            // Load audit logs
            try {
                const filter = document.getElementById('auditLogFilter')?.value || 'all';
                const params = filter !== 'all' ? `?action_type=${filter}` : '?limit=50';
                const auditResponse = await authFetch(`/api/audit-logs${params}`);
                if (auditResponse.ok) {
                    const auditLogs = await auditResponse.json();
                    renderAdminAuditLogs(auditLogs);
                }
            } catch (error) {
                console.error('Error loading audit logs for admin panel:', error);
                document.getElementById('adminAuditLogs').innerHTML = '<div style="color: #ef4444; text-align: center; padding: 1rem;">Error loading audit logs</div>';
            }
        }

        function renderAdminUsers(users) {
            const container = document.getElementById('adminUserList');
            if (!users || users.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 1rem; color: #94a3b8;">No users found</div>';
                return;
            }

            const roleColors = {
                'admin': '#10b981',
                'read-only': '#f59e0b',
                'write-only': '#3b82f6'
            };

            container.innerHTML = users.map(user => `
                <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: rgba(255, 255, 255, 0.05); border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.1);">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div style="font-weight: 600; color: white;">${escapeHtml(user.email || user.phone)}</div>
                            <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 0.25rem;">
                                ID: ${user.id} • Role: <span style="color: ${roleColors[user.role]};">${user.role}</span>
                            </div>
                        </div>
                    </div>
                </div>
            `).join('');
        }

        function renderAdminSessions(sessions) {
            const container = document.getElementById('adminSessionsList');
            if (!sessions || sessions.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 1rem; color: #94a3b8;">No active sessions</div>';
                return;
            }

            container.innerHTML = sessions.map(session => {
                const loginTime = new Date(session.login_time).toLocaleString();
                const lastActivity = new Date(session.last_activity).toLocaleString();
                
                return `
                    <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: rgba(255, 255, 255, 0.05); border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.1);">
                        <div style="font-weight: 600; color: white;">${escapeHtml(session.user_email || session.user_phone)}</div>
                        <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 0.25rem;">
                            📍 ${escapeHtml(session.location || 'Unknown')}
                        </div>
                        <div style="font-size: 0.75rem; color: #94a3b8;">
                            💻 ${escapeHtml(session.device_type)} • ${escapeHtml(session.browser)}
                        </div>
                        <div style="font-size: 0.75rem; color: #64748b; margin-top: 0.25rem;">
                            Last: ${lastActivity}
                        </div>
                    </div>
                `;
            }).join('');
        }

        function renderAdminAuditLogs(logs) {
            const container = document.getElementById('adminAuditLogs');
            if (!logs || logs.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 1rem; color: #94a3b8;">No audit logs found</div>';
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

            container.innerHTML = logs.map(log => {
                const timestamp = new Date(log.timestamp).toLocaleString();
                const icon = actionIcons[log.action_type] || '📋';
                const details = log.details ? JSON.parse(log.details) : {};
                
                return `
                    <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: rgba(255, 255, 255, 0.03); border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.08); font-size: 0.875rem;">
                        <div style="display: flex; justify-content: space-between; align-items: start;">
                            <div style="flex: 1;">
                                <span style="font-size: 1.25rem;">${icon}</span>
                                <strong style="color: white; margin-left: 0.5rem;">${log.action_type}</strong>
                                <div style="color: #94a3b8; margin-top: 0.25rem; margin-left: 2rem;">
                                    Actor: <span style="color: #60a5fa;">${escapeHtml(log.actor_email || 'System')}</span>
                                    ${log.target_email ? `→ Target: <span style="color: #f59e0b;">${escapeHtml(log.target_email)}</span>` : ''}
                                </div>
                                ${log.ip_address ? `<div style="color: #64748b; font-size: 0.75rem; margin-top: 0.25rem; margin-left: 2rem;">IP: ${escapeHtml(log.ip_address)}</div>` : ''}
                            </div>
                            <div style="text-align: right; color: #64748b; font-size: 0.75rem; white-space: nowrap;">
                                ${timestamp}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // SCHEMA SWITCHEROO: Global variable to control which webhook source to use
        // 'user' = output_0n (user-facing webhook, Bridges tab)
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
            
                // SCHEMA SWITCHEROO: Dev Panel reuses Bridges tab DOM completely
            if (tabName === 'devPanel') {
                const bridgesTab = document.getElementById('bridgesTab');
                if (bridgesTab) {
                    bridgesTab.classList.add('active');
                    bridgesTab.style.display = 'block';
                    
                    // SWITCHEROO: Change header and switch to ledger view (output_01)
                    const header = bridgesTab.querySelector('.section-header h1');
                    const subtitle = bridgesTab.querySelector('.section-header .create-bot-btn');
                    if (header) header.textContent = '🔧 Dev Panel - Ledger View (Read-Only)';
                    if (subtitle) subtitle.style.display = 'none'; // Hide Create Bridge button
                    
                    currentViewSource = 'ledger';
                    isDevPanelView = true;
                    
                    // Load system-wide bridges for Dev Panel
                    loadDevPanelBridges();
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
                    
                    // Restore Bridges tab header if switching back
                    if (tabName === 'bridges') {
                        const header = tabContent.querySelector('.section-header h1');
                        const createBtn = tabContent.querySelector('.section-header .create-bot-btn');
                        if (header) header.textContent = 'Bridge Library';
                        if (createBtn) createBtn.style.display = 'inline-block'; // Show Create Bridge button
                    }
                    
                    // Load data for the tab
                    if (tabName === 'bridges') {
                        loadBridges();
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
                const response = await authFetch('/api/users');
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
                    container.innerHTML = `<div style="padding: 3rem; color: #ef4444;">Error loading users: ${error.message}</div>`;
                }
            }
        }
        
        // Load Dev Panel (system-wide bridges overview)
        async function loadDevPanelAdmins() {
            console.log('🔧 Loading Dev Panel...');
            
            // Hide admin cards section (requires complex permissions)
            const adminCardsContainer = document.getElementById('devPanelAdminCards');
            if (adminCardsContainer) {
                adminCardsContainer.style.display = 'none';
            }
            
            // Just load system-wide bridges
            loadDevPanelBridges();
        }
        
        // Render horizontal admin cards in Dev Panel (system overview)
        function renderDevPanelAdminCards(tenants, adminsByTenant) {
            const container = document.getElementById('devPanelAdminCards');
            if (!container) return;
            
            if (tenants.length === 0) {
                container.innerHTML = '<div style="padding: 3rem; color: #94a3b8;">No admins found</div>';
                return;
            }
            
            container.innerHTML = tenants.map((tenant, index) => {
                const users = adminsByTenant[tenant];
                const genesisAdmin = users.find(u => u.role === 'admin' || u.role === 'dev') || users[0];
                const adminNumber = tenant.replace('tenant_', '').padStart(2, '0');
                const botCount = genesisAdmin.bridge_count || 0;
                const messageCount = genesisAdmin.message_count || 0;
                
                return `
                    <div class="glass-card" style="min-width: 300px; flex-shrink: 0; padding: 1.5rem;">
                        <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                            <div style="width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 1.5rem; font-weight: 700; flex-shrink: 0;">
                                ${adminNumber}
                            </div>
                            <div style="flex: 1; min-width: 0;">
                                <div style="color: white; font-weight: 600; font-size: 1.125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                    Admin #${adminNumber}
                                </div>
                                <div style="color: #94a3b8; font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                    ${escapeHtml(genesisAdmin.email)}
                                </div>
                            </div>
                        </div>
                        
                        <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                            <div style="flex: 1; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 0.5rem; padding: 0.75rem; text-align: center;">
                                <div style="color: #3b82f6; font-size: 1.5rem; font-weight: 700;">${botCount}</div>
                                <div style="color: #94a3b8; font-size: 0.75rem; margin-top: 0.25rem;">Bots</div>
                            </div>
                            <div style="flex: 1; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 0.5rem; padding: 0.75rem; text-align: center;">
                                <div style="color: #10b981; font-size: 1.5rem; font-weight: 700;">${messageCount}</div>
                                <div style="color: #94a3b8; font-size: 0.75rem; margin-top: 0.25rem;">Messages</div>
                            </div>
                        </div>
                        
                        <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.1);">
                            <div style="display: flex; align-items: center; gap: 0.5rem; color: #94a3b8; font-size: 0.75rem;">
                                <span>🏠</span>
                                <span>${tenant}</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 0.5rem; color: #94a3b8; font-size: 0.75rem; margin-top: 0.25rem;">
                                <span>👤</span>
                                <span>${users.length} ${users.length === 1 ? 'user' : 'users'} in tenant</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }
        
        // Render user management for admins (tenant-specific)
        function renderAdminUserManagement(allUsers) {
            const container = document.getElementById('adminCards');
            if (!container) return;
            
            // Filter users in this admin's tenant only
            const tenantUsers = allUsers.filter(u => u.tenant_id === currentUser.tenant_id);
            
            container.innerHTML = `
                <div style="width: 100%; max-width: 800px;">
                    <div class="glass-card" style="padding: 1.5rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                            <h2 style="font-size: 1.25rem; font-weight: 600; color: white;">👥 Tenant Users</h2>
                            <button class="create-bot-btn" data-action="openCreateUserModal" style="padding: 0.5rem 1rem; font-size: 0.875rem;">+ Invite User</button>
                        </div>
                        
                        ${tenantUsers.length === 0 ? `
                            <div style="text-align: center; padding: 3rem; color: #94a3b8;">
                                <p style="margin-bottom: 1rem;">No additional users in your tenant</p>
                                <p style="font-size: 0.875rem;">Click "+ Invite User" to add read-only or write-only users</p>
                            </div>
                        ` : `
                            <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                                ${tenantUsers.map(user => `
                                    <div class="user-item">
                                        <div style="display: flex; justify-content: space-between; align-items: center;">
                                            <div style="flex: 1;">
                                                <div style="display: flex; align-items: center; gap: 0.5rem;">
                                                    <strong style="color: white;">${escapeHtml(user.email)}</strong>
                                                    <span class="stat-badge" style="background: rgba(59, 130, 246, 0.2); color: #3b82f6; font-size: 0.75rem; padding: 0.25rem 0.5rem;">${user.role}</span>
                                                    ${user.is_genesis_admin ? '<span class="stat-badge" style="background: rgba(251, 191, 36, 0.2); color: #fbbf24; font-size: 0.75rem; padding: 0.25rem 0.5rem;">Genesis Admin</span>' : ''}
                                                </div>
                                                <div style="color: #94a3b8; font-size: 0.875rem; margin-top: 0.25rem;">
                                                    Created: ${new Date(user.created_at).toLocaleDateString()}
                                                </div>
                                            </div>
                                            ${!user.is_genesis_admin && user.role !== 'admin' ? `<button class="btn-icon btn-danger" data-delete-user="${user.id}" title="Remove User">🗑️</button>` : ''}
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        `}
                    </div>
                </div>
            `;
        }
        
        // Load users for Dev Panel
        async function loadDevPanelUsers() {
            try {
                const response = await authFetch('/api/users');
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                users = await response.json();
                renderDevPanelUsers();
            } catch (error) {
                console.error('Error loading dev panel users:', error);
                const userList = document.getElementById('devUserList');
                if (userList) {
                    userList.innerHTML = `<div style="text-align: center; padding: 3rem; color: #ef4444;">Error loading users: ${error.message}</div>`;
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
        
        // DEV PANEL: Show bridge information modal (read-only)
        function showBridgeInfo(fractalId) {
            const bridge = bots.find(b => b.fractal_id === fractalId);
            if (!bridge) return;
            
            const tenantNum = String(bridge.tenant_id || 1).padStart(2, '0');
            const infoHTML = `
                <div class="modal-content" style="max-width: 600px;">
                    <div class="modal-header">
                        <h2 class="modal-title">ℹ️ Bridge Information</h2>
                        <button class="close-btn" data-close-modal="bridgeInfoModal">×</button>
                    </div>
                    <div style="padding: 1.5rem;">
                        <div style="background: rgba(255,255,255,0.03); border-radius: 12px; padding: 1.5rem;">
                            <div class="detail-row" style="margin-bottom: 1rem;">
                                <span class="detail-label">Tenant</span>
                                <span class="detail-value">Admin #${tenantNum} (${bridge.tenant_owner_email || 'Unknown'})</span>
                            </div>
                            <div class="detail-row" style="margin-bottom: 1rem;">
                                <span class="detail-label">Fractal ID</span>
                                <span class="detail-value" style="font-family: monospace; font-size: 0.875rem;">${bridge.fractal_id}</span>
                            </div>
                            <div class="detail-row" style="margin-bottom: 1rem;">
                                <span class="detail-label">Input Platform</span>
                                <span class="detail-value">${bridge.input_platform || 'whatsapp'}</span>
                            </div>
                            <div class="detail-row" style="margin-bottom: 1rem;">
                                <span class="detail-label">Output Platform</span>
                                <span class="detail-value">${bridge.output_platform || 'discord'}</span>
                            </div>
                            <div class="detail-row" style="margin-bottom: 1rem;">
                                <span class="detail-label">Created</span>
                                <span class="detail-value">${new Date(bridge.created_at).toLocaleString()}</span>
                            </div>
                            ${bridge.output_0n_url ? `
                            <div class="detail-row">
                                <span class="detail-label">User Webhook (Output #0n)</span>
                                <span class="detail-value" style="font-size: 0.75rem; word-break: break-all; font-family: monospace;">${bridge.output_0n_url}</span>
                            </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
            
            let modal = document.getElementById('bridgeInfoModal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'bridgeInfoModal';
                modal.className = 'modal';
                document.body.appendChild(modal);
            }
            modal.innerHTML = infoHTML;
            modal.style.display = 'flex';
        }
        
        function closeModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.style.display = 'none';
        }
        
        // SCHEMA SWITCHEROO: Load system-wide bridges for Dev Panel, then reuse Bridges tab rendering
        async function loadDevPanelBridges() {
            try {
                console.log('🔧 Dev Panel: Loading system-wide bridges...');
                const response = await authFetch('/api/dev/bridges');
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const systemBridges = await response.json();
                console.log(`✅ Dev Panel: Loaded ${systemBridges.length} bridges across all tenants`);
                
                // REUSE: Store in global bots array (same as Bridges tab)
                bots = systemBridges;
                
                // REUSE: Call existing bridge rendering (will use source=ledger automatically)
                renderBridgesSidebar();
                
                // Auto-select first bridge
                if (bots.length > 0 && !selectedBotId) {
                    selectBot(bots[0].fractal_id);
                }
            } catch (error) {
                console.error('❌ Dev Panel: Failed to load bridges:', error);
                const sidebar = document.getElementById('bridgeListContainer');
                if (sidebar) {
                    sidebar.innerHTML = `<div style="padding: 2rem; color: #ef4444; text-align: center;">Error: ${error.message}</div>`;
                }
            }
        }
        
        // Render Dev Panel bridges in Discord-style sidebar
        function renderDevPanelBridgesSidebar() {
            const sidebar = document.getElementById('devPanelBridgeSidebar');
            const countEl = document.getElementById('devPanelBridgeCount');
            
            if (!sidebar) return;
            
            if (countEl) {
                countEl.textContent = devPanelBridges.length;
            }
            
            if (devPanelBridges.length === 0) {
                sidebar.innerHTML = '<div style="padding: 2rem; color: #94a3b8; text-align: center;">No bridges</div>';
                return;
            }
            
            // Group by tenant
            const byTenant = {};
            devPanelBridges.forEach(bridge => {
                const tenant = `tenant_${bridge.tenant_id}`;
                if (!byTenant[tenant]) byTenant[tenant] = [];
                byTenant[tenant].push(bridge);
            });
            
            sidebar.innerHTML = Object.keys(byTenant).sort().map(tenant => {
                const bridges = byTenant[tenant];
                const tenantNum = tenant.replace('tenant_', '');
                
                return `
                    <div style="margin-bottom: 1rem;">
                        <div style="font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; font-weight: 600; margin-bottom: 0.5rem; padding: 0 0.5rem;">
                            Tenant ${tenantNum}
                        </div>
                        ${bridges.map(bridge => {
                            const isSelected = bridge.fractal_id === selectedDevBridgeId;
                            const statusIcon = getStatusBadge(bridge.status).emoji;
                            
                            return `
                                <div class="channel-item ${isSelected ? 'active' : ''}" 
                                     data-bridge-id="${bridge.fractal_id}"
                                     data-dev-bridge="${bridge.fractal_id}"
                                     style="padding: 0.75rem; margin: 0.25rem 0; cursor: pointer; border-radius: 8px; background: ${isSelected ? 'rgba(255,255,255,0.1)' : 'transparent'}; transition: all 0.2s;">
                                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                                        <span style="font-size: 1rem;">${statusIcon}</span>
                                        <span style="color: ${isSelected ? 'white' : '#cbd5e1'}; font-weight: ${isSelected ? '600' : '400'}; font-size: 0.875rem;">
                                            ${bridge.name || bridge.input_platform + ' → ' + bridge.output_platform}
                                        </span>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }).join('');
        }
        
        // Select and display dev bridge details
        function selectDevBridge(fractalId) {
            selectedDevBridgeId = fractalId;
            const bridge = devPanelBridges.find(b => b.fractal_id === fractalId);
            if (bridge) {
                renderDevPanelBridgesSidebar(); // Re-render to update selection
                renderDevPanelBridgeDetail(bridge);
            }
        }
        
        // Render bridge detail view
        function renderDevPanelBridgeDetail(bridge) {
            const detail = document.getElementById('devPanelBridgeDetail');
            if (!detail) return;
            
            const statusBadge = getStatusBadge(bridge.status);
            const tenantNum = String(bridge.tenant_id).padStart(2, '0');
            
            detail.innerHTML = `
                <div style="margin-bottom: 1.5rem;">
                    <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                        <h2 style="color: white; font-size: 1.5rem; font-weight: 700; margin: 0;">
                            ${bridge.name || bridge.input_platform + ' → ' + bridge.output_platform}
                        </h2>
                        <span style="background: ${statusBadge.color}; color: white; padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600;">
                            ${statusBadge.emoji} ${statusBadge.label}
                        </span>
                    </div>
                    
                    <div style="display: grid; gap: 1rem;">
                        <div class="detail-row">
                            <span class="detail-label">Tenant</span>
                            <span class="detail-value">Admin #${tenantNum} (${bridge.tenant_owner_email})</span>
                        </div>
                        
                        <div class="detail-row">
                            <span class="detail-label">Fractal ID</span>
                            <span class="detail-value" style="font-family: monospace; font-size: 0.875rem;">${bridge.fractal_id}</span>
                        </div>
                        
                        <div class="detail-row">
                            <span class="detail-label">Input Platform</span>
                            <span class="detail-value">${bridge.input_platform}</span>
                        </div>
                        
                        <div class="detail-row">
                            <span class="detail-label">Output Platform</span>
                            <span class="detail-value">${bridge.output_platform}</span>
                        </div>
                        
                        ${bridge.contact_info ? `
                        <div class="detail-row">
                            <span class="detail-label">Contact Info</span>
                            <span class="detail-value">${bridge.contact_info}</span>
                        </div>
                        ` : ''}
                        
                        <div class="detail-row">
                            <span class="detail-label">Created</span>
                            <span class="detail-value">${new Date(bridge.created_at).toLocaleString()}</span>
                        </div>
                        
                        ${bridge.output_0n_url ? `
                        <div class="detail-row">
                            <span class="detail-label">User Webhook (Output #0n)</span>
                            <span class="detail-value" style="font-size: 0.875rem; word-break: break-all;">${bridge.output_0n_url}</span>
                        </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }
        
        function renderDevPanelUsers() {
            const userList = document.getElementById('devUserList');
            if (!userList) return;
            
            if (!users || users.length === 0) {
                userList.innerHTML = '<div style="text-align: center; padding: 3rem; color: #94a3b8;">No users found</div>';
                return;
            }
            
            userList.innerHTML = users.map(user => `
                <div class="user-item">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <strong style="color: white;">${escapeHtml(user.email)}</strong>
                                <span class="stat-badge" style="background: rgba(59, 130, 246, 0.2); color: #3b82f6; font-size: 0.75rem; padding: 0.25rem 0.5rem;">${user.role}</span>
                                <span class="stat-badge" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;">${user.tenant_schema || 'public'}</span>
                            </div>
                            <div style="color: #94a3b8; font-size: 0.875rem; margin-top: 0.25rem;">
                                Created: ${new Date(user.created_at).toLocaleDateString()}
                            </div>
                        </div>
                        <button class="btn-icon btn-danger" data-delete-user="${user.id}" title="Delete User">🗑️</button>
                    </div>
                </div>
            `).join('');
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

        // Initialize
        handleOAuthCallback();
        console.log('🔐 Checking authentication...');
        checkAuth().then(authenticated => {
            console.log('🔐 Auth result:', authenticated);
            if (authenticated) {
                loadBridges();
                initHopAnimation();
            } else {
                console.warn('⚠️ Not authenticated - skipping cat animation');
            }
        });
        // ===== SYSTEM STATUS BAR =====
        let startTime = Date.now();
        
        function updateSystemStatus() {
            // Update uptime
            const uptime = Date.now() - startTime;
            const hours = Math.floor(uptime / 3600000);
            const minutes = Math.floor((uptime % 3600000) / 60000);
            
            // Update uptime in compact indicators only
            const uptimeEl = document.getElementById('systemUptimeCompact');
            if (uptimeEl) uptimeEl.textContent = `${hours}h ${minutes}m`;
            
            // Update current time (two-line format under cat animation)
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const timeHours = now.getHours();
            const timeMinutes = String(now.getMinutes()).padStart(2, '0');
            const timeSeconds = String(now.getSeconds()).padStart(2, '0');
            const ampm = timeHours >= 12 ? 'PM' : 'AM';
            const displayHours = timeHours % 12 || 12;
            const currentTimeEl = document.getElementById('currentTime');
            if (currentTimeEl) currentTimeEl.innerHTML = `${year}/${month}/${day}<br>${displayHours}:${timeMinutes}:${timeSeconds}${ampm}`;
            
            // Update bridge count in compact indicators only
            const bridgeCountEl = document.getElementById('bridgeCountCompact');
            if (bridgeCountEl) bridgeCountEl.textContent = bridges.length;
            
            // Update active sessions in compact indicators only
            if (window.sessions) {
                const activeCount = sessions.filter(s => s.is_active).length;
                const activeSessionsEl = document.getElementById('activeSessionsCompact');
                if (activeSessionsEl) activeSessionsEl.textContent = activeCount;
            }
        }
        
        // Update status every second
        setInterval(updateSystemStatus, 1000);
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
            'createBridge': {
                element: '.create-bot-btn',
                text: 'Click here to connect two platforms (e.g., WhatsApp → Discord)',
                shown: false
            },
            'searchMessages': {
                element: '.discord-search-input',
                text: 'Search through all messages in this bridge',
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
            hintEl.innerHTML = `
                ${hint.text}
                <button class="close-hint" data-dismiss-hint('${hintKey}', this)">×</button>
            `;
            
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
            if (bridges.length === 0) {
                showOnboardingHint('createBridge');
            }
        }, 2000);
        
        setTimeout(() => {
            showOnboardingHint('analytics');
        }, 5000);

// ===== EVENT LISTENER BINDINGS (CSP-Safe) =====
// All event handlers bound here instead of inline onclick/onsubmit attributes
document.addEventListener('DOMContentLoaded', function() {
    // Logout button
    const logoutBtn = document.querySelector('.logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);
    
    // Modal close buttons and backdrop clicks
    const mediaModal = document.getElementById('mediaModal');
    if (mediaModal) {
        mediaModal.addEventListener('click', function(e) {
            if (e.target === this) closeMediaModal();
        });
        const mediaModalClose = mediaModal.querySelector('.media-modal-close');
        if (mediaModalClose) mediaModalClose.addEventListener('click', closeMediaModal);
    }
    
    const createBridgeModal = document.getElementById('createBridgeModal');
    if (createBridgeModal) {
        createBridgeModal.addEventListener('click', function(e) {
            if (e.target === this) closeCreateBridgeModal();
        });
        const bridgeModalClose = createBridgeModal.querySelector('.bridge-modal-close');
        if (bridgeModalClose) bridgeModalClose.addEventListener('click', closeCreateBridgeModal);
    }
    
    const qrModal = document.getElementById('qrModal');
    if (qrModal) {
        const qrModalClose = qrModal.querySelector('.close-btn');
        if (qrModalClose) qrModalClose.addEventListener('click', closeQRModal);
    }
    
    const botModal = document.getElementById('botModal');
    if (botModal) {
        const botModalClose = botModal.querySelector('.close-btn');
        if (botModalClose) botModalClose.addEventListener('click', closeBotModal);
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
    
    const bridgeCreateForm = document.getElementById('bridge-create-form');
    if (bridgeCreateForm) bridgeCreateForm.addEventListener('submit', function(e) {
        e.preventDefault();
        // Bridge creation logic is already in dashboard.js
    });
    
    // Button clicks
    const createBotBtn = document.querySelector('.create-bot-btn');
    if (createBotBtn) createBotBtn.addEventListener('click', openCreatePopup);
    
    const auditTypeBtn = document.querySelector('.audit-type-btn');
    if (auditTypeBtn) auditTypeBtn.addEventListener('click', () => {
        showToast('🧿 Agent Layer coming soon! (Check/Remind/Alert/Reward/Execute)', 'info');
    });
    
    const revokeAllBtn = document.querySelector('[onclick*="revokeAllSessions"]');
    if (revokeAllBtn) {
        revokeAllBtn.removeAttribute('onclick');
        revokeAllBtn.addEventListener('click', revokeAllSessions);
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
    
    const analyticsBridgeFilter = document.getElementById('analyticsBridgeFilter');
    if (analyticsBridgeFilter) analyticsBridgeFilter.addEventListener('change', loadAnalyticsDashboard);
    
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
    
    const startBridgeSetupBtn = document.querySelector('[onclick*="startBridgeSetup"]');
    if (startBridgeSetupBtn) {
        startBridgeSetupBtn.removeAttribute('onclick');
        startBridgeSetupBtn.addEventListener('click', startBridgeSetup);
    }
    
    const addWebhookBtn = document.querySelector('[onclick*="addWebhookInput"]');
    if (addWebhookBtn) {
        addWebhookBtn.removeAttribute('onclick');
        addWebhookBtn.addEventListener('click', addWebhookInput);
    }
    
    const copyFractalIdBtn = document.querySelector('[onclick*="copyBridgeFractalId"]');
    if (copyFractalIdBtn) {
        copyFractalIdBtn.removeAttribute('onclick');
        copyFractalIdBtn.addEventListener('click', copyBridgeFractalId);
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
            const bridgeId = e.target.dataset.bridgeId;
            
            console.log('📋 Extracted msgId:', msgId);
            console.log('📋 Extracted bridgeId:', bridgeId);
            
            if (!msgId || !bridgeId) {
                console.warn('⚠️ Missing msgId or bridgeId:', { msgId, bridgeId, element: e.target });
                return;
            }
            
            if (!selectedMessages[bridgeId]) {
                selectedMessages[bridgeId] = new Set();
            }
            
            if (e.target.checked) {
                selectedMessages[bridgeId].add(msgId);
                console.log(`✓ Selected message ${msgId} in bridge ${bridgeId} (total: ${selectedMessages[bridgeId].size})`);
            } else {
                selectedMessages[bridgeId].delete(msgId);
                console.log(`✗ Deselected message ${msgId} in bridge ${bridgeId} (total: ${selectedMessages[bridgeId].size})`);
            }
            
            console.log('📋 Calling updateExportButtonState for bridge:', bridgeId);
            updateExportButtonState(bridgeId);
        }
        
        // Select all checkbox
        if (e.target.id && e.target.id.startsWith('select-all-')) {
            const bridgeId = e.target.id.replace('select-all-', '');
            const checkboxes = document.querySelectorAll(`.message-export-checkbox[data-bridge-id="${bridgeId}"], .message-checkbox[data-bridge-id="${bridgeId}"]`);
            
            console.log(`Select all for bridge ${bridgeId}: found ${checkboxes.length} checkboxes`);
            
            if (!selectedMessages[bridgeId]) {
                selectedMessages[bridgeId] = new Set();
            }
            
            if (e.target.checked) {
                checkboxes.forEach(cb => {
                    cb.checked = true;
                    const msgId = cb.dataset.messageId || cb.dataset.msgId;
                    if (msgId) {
                        selectedMessages[bridgeId].add(msgId);
                    }
                });
                console.log(`✓ Selected ${checkboxes.length} messages in bridge ${bridgeId}`);
            } else {
                checkboxes.forEach(cb => {
                    cb.checked = false;
                });
                selectedMessages[bridgeId].clear();
                console.log(`✗ Cleared all selections in bridge ${bridgeId}`);
            }
            
            updateExportButtonState(bridgeId);
        }
    });
});

// ============ DROPS API - Personal Cloud OS ============
// Save a drop (link metadata to Discord message) - APPENDS to existing tags
async function saveDrop(bridgeId, messageId, metadataText, section) {
    try {
        const response = await fetch('/api/drops', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
            },
            body: JSON.stringify({
                bridge_id: bridgeId,
                discord_message_id: messageId,
                metadata_text: metadataText
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to save drop');
        }
        
        const data = await response.json();
        
        // Clear input and display the drop (will show all tags as bubbles) - pass fractal_id
        section.querySelector('.drop-input').value = '';
        displayDrop(section, data.drop, data.extracted, bridgeId);
        
    } catch (error) {
        console.error('Error saving drop:', error);
        alert('Failed to save metadata. Please try again.');
    }
}

// Remove a specific tag from a message's drop
async function removeTag(bridgeId, messageId, tag) {
    try {
        console.log('🗑️ Removing tag:', { bridgeId, messageId, tag });
        
        const response = await fetch('/api/drops/tag', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
            },
            body: JSON.stringify({
                bridge_id: bridgeId,
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
        const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"][data-bridge-id="${bridgeId}"]`);
        if (section && data.drop) {
            displayDrop(section, data.drop, null, bridgeId); // Pass fractal_id!
        }
        
    } catch (error) {
        console.error('Error removing tag:', error);
        alert('Failed to remove tag. Please try again.');
    }
}

// Fetch all drops for a bridge
async function fetchDrops(bridgeId) {
    try {
        const response = await fetch(`/api/drops/${bridgeId}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
            }
        });
        
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
function displayDrop(section, drop, extracted, fractalBridgeId) {
    const display = section.querySelector('.drop-display');
    if (!display) return;
    
    // Get fractal_id from section if not provided
    const bridgeFractalId = fractalBridgeId || section.getAttribute('data-bridge-id');
    
    // Handle both formats: extracted object (from POST response) or direct arrays (from GET response)
    const tags = extracted?.tags || drop.extracted_tags || [];
    const dates = extracted?.dates || drop.extracted_dates || [];
    
    // Tag bubbles with × delete button (use fractal_id, NOT internal bridge_id)
    const tagsHTML = tags.length > 0 
        ? tags.map(tag => `
            <span class="drop-tag" style="display: inline-flex; align-items: center; gap: 0.25rem; background: rgba(168, 85, 247, 0.2); color: #c084fc; padding: 0.25rem 0.5rem; border-radius: 1rem; font-size: 0.75rem; margin-right: 0.25rem;">
                ${escapeHtml(tag)}
                <button class="tag-remove" data-action="remove-tag" data-tag="${escapeHtml(tag)}" data-message-id="${drop.discord_message_id}" data-bridge-id="${bridgeFractalId}" style="background: none; border: none; color: #c084fc; cursor: pointer; font-size: 1rem; line-height: 1; padding: 0; margin-left: 0.125rem; opacity: 0.7; transition: opacity 0.2s;">×</button>
            </span>
        `).join(' ')
        : '';
    
    const datesHTML = dates.length > 0
        ? dates.map(date => `<span class="drop-date" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; padding: 0.25rem 0.5rem; border-radius: 1rem; font-size: 0.75rem; margin-right: 0.25rem;">📅 ${escapeHtml(date)}</span>`).join(' ')
        : '';
    
    display.innerHTML = `
        <div class="drop-metadata">
            ${tagsHTML ? `<div class="drop-tags" style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.5rem;">${tagsHTML}</div>` : ''}
            ${datesHTML ? `<div class="drop-dates" style="display: flex; flex-wrap: wrap; gap: 0.25rem;">${datesHTML}</div>` : ''}
        </div>
    `;
    display.classList.remove('hidden');
}

// Hydrate drops for all messages in a bridge
async function hydrateDropsForBridge(bridgeId) {
    const drops = await fetchDrops(bridgeId);
    
    drops.forEach(drop => {
        const section = document.querySelector(`.message-drop-section[data-message-id="${drop.discord_message_id}"][data-bridge-id="${bridgeId}"]`);
        if (section) {
            displayDrop(section, drop, null, bridgeId); // Pass fractal_id
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
    
    // Bridge selection
    if (target.classList.contains('channel-item') || target.closest('.channel-item')) {
        const item = target.classList.contains('channel-item') ? target : target.closest('.channel-item');
        const fractalId = item.getAttribute('data-fractal-id');
        if (fractalId && !item.classList.contains('active')) {
            selectBridge(fractalId);
        }
        return;
    }
    
    // Generate QR button
    if (target.hasAttribute('data-generate-qr')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-generate-qr');
        if (fractalId) generateNewQR(fractalId);
        return;
    }
    
    // Edit bridge button
    if (target.hasAttribute('data-edit-bridge')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-edit-bridge');
        if (fractalId) editBridge(fractalId);
        return;
    }
    
    // Delete bridge button
    if (target.hasAttribute('data-delete-bridge')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-delete-bridge');
        if (fractalId) confirmDeleteBridge(fractalId);
        return;
    }
    
    // Export bridge data button
    if (target.hasAttribute('data-export-bridge')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-export-bridge');
        if (fractalId) exportBridgeData(fractalId);
        return;
    }
    
    // Clear bridge search filter
    if (target.hasAttribute('data-clear-filter')) {
        e.preventDefault();
        const fractalId = target.getAttribute('data-clear-filter');
        if (fractalId) clearBridgeSearchFilter(fractalId);
        return;
    }
    
    // Table column sorting
    if (target.closest('th[data-sort-column]')) {
        const th = target.closest('th[data-sort-column]');
        const bridgeId = th.getAttribute('data-bridge-id');
        const column = th.getAttribute('data-sort-column');
        if (bridgeId && column) sortMessagesTable(bridgeId, column);
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
    // EXCLUDE interactive form elements (checkboxes, text inputs, buttons)
    const isInteractiveElement = target.tagName === 'INPUT' || 
                                   target.tagName === 'TEXTAREA' || 
                                   target.tagName === 'BUTTON' || 
                                   target.tagName === 'LABEL' ||
                                   target.closest('label') ||
                                   target.closest('button');
    
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
    
    // Pagination buttons
    if (target.hasAttribute('data-load-page')) {
        e.preventDefault();
        const bridgeId = target.getAttribute('data-bridge-id');
        const page = parseInt(target.getAttribute('data-load-page'));
        if (bridgeId && page) loadBridgeMessages(bridgeId, page);
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
    
    // Dev panel bridge selection
    if (target.hasAttribute('data-dev-bridge')) {
        const fractalId = target.getAttribute('data-dev-bridge');
        if (fractalId) selectDevBridge(fractalId);
        return;
    }
    
    // Hint dismissal
    if (target.classList.contains('close-hint') || target.hasAttribute('data-dismiss-hint')) {
        e.preventDefault();
        const hintKey = target.getAttribute('data-dismiss-hint') || target.closest('[data-dismiss-hint]')?.getAttribute('data-dismiss-hint');
        if (hintKey && typeof dismissHint === 'function') dismissHint(hintKey, target);
        return;
    }
    
    // ============ DROPS - Personal Cloud OS ============
    // Save drop button
    if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'save-drop') {
        e.preventDefault();
        const messageId = target.getAttribute('data-message-id');
        const bridgeId = target.getAttribute('data-bridge-id');
        const section = document.querySelector(`.message-drop-section[data-message-id="${messageId}"]`);
        const input = section?.querySelector('.drop-input');
        const metadataText = input?.value.trim();
        
        if (metadataText && bridgeId) {
            saveDrop(bridgeId, messageId, metadataText, section);
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
        const bridgeId = target.getAttribute('data-bridge-id');
        
        console.log('Extracted attributes:', { tag, messageId, bridgeId });
        
        if (tag && messageId && bridgeId) {
            removeTag(bridgeId, messageId, tag);
        } else {
            console.error('❌ Missing attributes for tag removal!', { tag, messageId, bridgeId });
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
        const bridgeId = target.getAttribute('data-filter-table');
        if (bridgeId) filterMessagesTable(bridgeId);
        return;
    }
});

// ============================================================================
// SIDEBAR RESIZER - Draggable width adjustment
// ============================================================================
(function initSidebarResizer() {
    const resizer = document.getElementById('sidebarResizer');
    const sidebar = document.getElementById('bridgeSidebar');
    
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
        
        // Save to localStorage
        const currentWidth = sidebar.offsetWidth;
        localStorage.setItem(STORAGE_KEY, currentWidth.toString());
    }
    
    // Mouse events
    resizer.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
    
    // Touch events for iPad
    resizer.addEventListener('touchstart', startResize);
    document.addEventListener('touchmove', resize);
    document.addEventListener('touchend', stopResize);
})();

// ============================================================================
// HEADER RESIZER - Draggable height adjustment
// ============================================================================
(function initHeaderResizer() {
    const resizer = document.getElementById('headerResizer');
    const header = document.querySelector('.header');
    
    if (!resizer || !header) return;
    
    // Min/max constraints for header height
    const MIN_HEIGHT = 40;
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
        
        // Save to localStorage
        const currentHeight = header.offsetHeight;
        localStorage.setItem(STORAGE_KEY, currentHeight.toString());
    }
    
    // Mouse events
    resizer.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
    
    // Touch events for iPad
    resizer.addEventListener('touchstart', startResize);
    document.addEventListener('touchmove', resize);
    document.addEventListener('touchend', stopResize);
})();
