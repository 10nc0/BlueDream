/**
 * Media Loader with Client-Side Caching
 * - Lazy loads media only when visible (IntersectionObserver)
 * - Caches in IndexedDB with 90-minute TTL
 * - Memory cache for instant re-render
 * - Prevents constant re-downloading
 */

// Memory cache for instant access
const mediaMemoryCache = new Map();

// IndexedDB setup for persistent caching
let mediaDB = null;

async function initMediaDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('NyanBridgeMediaCache', 1);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            mediaDB = request.result;
            resolve(mediaDB);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('media')) {
                const objectStore = db.createObjectStore('media', { keyPath: 'messageId' });
                objectStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

// Initialize on load
initMediaDB().catch(console.error);

// Clean expired cache entries (90 minutes TTL)
async function cleanExpiredCache() {
    if (!mediaDB) return;
    
    const transaction = mediaDB.transaction(['media'], 'readwrite');
    const objectStore = transaction.objectStore('media');
    const index = objectStore.index('timestamp');
    const expiryTime = Date.now() - (90 * 60 * 1000); // 90 minutes ago
    
    const request = index.openCursor();
    request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
            if (cursor.value.timestamp < expiryTime) {
                cursor.delete();
            }
            cursor.continue();
        }
    };
}

// Run cleanup every 10 minutes
setInterval(cleanExpiredCache, 10 * 60 * 1000);

// Get media from cache (memory first, then IndexedDB)
async function getCachedMedia(messageId) {
    // Check memory cache first
    if (mediaMemoryCache.has(messageId)) {
        return mediaMemoryCache.get(messageId);
    }
    
    // Check IndexedDB
    if (!mediaDB) return null;
    
    return new Promise((resolve) => {
        const transaction = mediaDB.transaction(['media'], 'readonly');
        const objectStore = transaction.objectStore('media');
        const request = objectStore.get(messageId);
        
        request.onsuccess = () => {
            const cached = request.result;
            if (cached) {
                // Check if expired (90 minutes)
                const age = Date.now() - cached.timestamp;
                if (age < 90 * 60 * 1000) {
                    // Cache in memory for faster access
                    mediaMemoryCache.set(messageId, cached.data);
                    resolve(cached.data);
                } else {
                    // Expired, delete it
                    const deleteTransaction = mediaDB.transaction(['media'], 'readwrite');
                    deleteTransaction.objectStore('media').delete(messageId);
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        };
        
        request.onerror = () => resolve(null);
    });
}

// Save media to cache
async function cacheMedia(messageId, mediaData) {
    // Save to memory cache
    mediaMemoryCache.set(messageId, mediaData);
    
    // Save to IndexedDB
    if (!mediaDB) return;
    
    const transaction = mediaDB.transaction(['media'], 'readwrite');
    const objectStore = transaction.objectStore('media');
    objectStore.put({
        messageId,
        data: mediaData,
        timestamp: Date.now()
    });
}

// Fetch media from server with retry logic and exponential backoff
async function fetchMediaFromServer(messageId, retryCount = 0, maxRetries = 3) {
    const baseDelay = 1000; // 1 second
    
    try {
        // Use the global authFetch function
        if (!window.authFetch) {
            throw new Error('authFetch not available - script loading order issue');
        }
        
        console.log(`📥 Fetching media for message ${messageId} (attempt ${retryCount + 1}/${maxRetries + 1})...`);
        const response = await window.authFetch(`/api/messages/${messageId}/media`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Media fetch failed: ${response.status} ${response.statusText}`, errorText);
            throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
        }
        
        const data = await response.json();
        console.log(`✅ Media fetched for message ${messageId}:`, data.media_type);
        return data;
    } catch (error) {
        // Retry with exponential backoff for network errors
        if (retryCount < maxRetries && (error.message.includes('HTTP 5') || error.name === 'TypeError')) {
            const delay = baseDelay * Math.pow(2, retryCount);
            console.warn(`⚠️ Retrying media fetch for message ${messageId} in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchMediaFromServer(messageId, retryCount + 1, maxRetries);
        }
        
        console.error(`❌ Failed to fetch media for message ${messageId} after ${retryCount + 1} attempts:`, {
            name: error.name,
            message: error.message,
            stack: error.stack
        });
        throw error;
    }
}

// Load and render media for a message
async function loadMedia(messageId) {
    const previewEl = document.getElementById(`media-preview-${messageId}`);
    if (!previewEl) {
        console.error(`❌ Media preview element not found for message ${messageId}`);
        return;
    }
    
    console.log(`📥 Starting media load for message ${messageId}`);
    
    try {
        // Check cache first
        let mediaData = await getCachedMedia(messageId);
        
        if (mediaData) {
            console.log(`✅ Using cached media for message ${messageId}`);
        } else {
            console.log(`📡 Fetching media from server for message ${messageId}`);
            // If not cached, fetch from server
            mediaData = await fetchMediaFromServer(messageId);
            // Cache for future use
            await cacheMedia(messageId, mediaData);
            console.log(`✅ Cached media for message ${messageId}`);
        }
        
        // Render the media
        console.log(`🎨 Rendering media for message ${messageId}`);
        renderMedia(previewEl, messageId, mediaData);
        console.log(`✅ Media rendered successfully for message ${messageId}`);
        
    } catch (error) {
        console.error(`❌ Error loading media for message ${messageId}:`, error);
        // Show error message
        previewEl.innerHTML = `<div class="media-error">Failed to load media: ${error.message}</div>`;
    }
}

// Generate blur placeholder for progressive loading
function generateBlurPlaceholder() {
    // Simple SVG blur placeholder
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'%3E%3Cfilter id='b' x='0' y='0'%3E%3CfeGaussianBlur stdDeviation='20'/%3E%3C/filter%3E%3Crect width='400' height='300' fill='%2330415f' filter='url(%23b)'/%3E%3C/svg%3E`;
}

// Render media element based on type with progressive loading
function renderMedia(containerEl, messageId, mediaData) {
    const { media_data, media_type, sender_name } = mediaData;
    
    // Debug logging
    console.log(`🎨 Render details for message ${messageId}:`, {
        hasMediaData: !!media_data,
        mediaDataLength: media_data ? media_data.length : 0,
        mediaType: media_type,
        senderName: sender_name
    });
    
    // Validate media_data exists
    if (!media_data) {
        console.error(`❌ No media_data for message ${messageId}`);
        containerEl.innerHTML = '<div class="media-error">No media data available</div>';
        return;
    }
    
    // Handle both full MIME types (image/jpeg) and legacy simple types (image)
    const normalizedType = (media_type || '').toLowerCase();
    const isImage = normalizedType.startsWith('image/') || normalizedType === 'image';
    const isVideo = normalizedType.startsWith('video/') || normalizedType === 'video';
    const isAudio = normalizedType.startsWith('audio/') || normalizedType === 'audio';
    
    // Check if media_data already has the data: prefix
    let dataUrl;
    if (media_data.startsWith('data:')) {
        // Already has data URL prefix, use as-is
        dataUrl = media_data;
        console.log(`📊 Using existing dataUrl for message ${messageId}: ${dataUrl.substring(0, 100)}... (length: ${dataUrl.length})`);
    } else {
        // Need to add data URL prefix
        let mimeType = media_type;
        if (normalizedType === 'image') mimeType = 'image/jpeg';
        if (normalizedType === 'video') mimeType = 'video/mp4';
        if (normalizedType === 'audio') mimeType = 'audio/mpeg';
        
        dataUrl = `data:${mimeType};base64,${media_data}`;
        console.log(`📊 Generated dataUrl for message ${messageId}: ${dataUrl.substring(0, 100)}... (length: ${dataUrl.length})`);
    }
    
    let mediaHTML = '';
    
    if (isImage) {
        const blurPlaceholder = generateBlurPlaceholder();
        mediaHTML = `
            <div class="media-progressive-container" style="position: relative; overflow: hidden; border-radius: 8px;">
                <img 
                    class="media-blur-placeholder"
                    src="${blurPlaceholder}"
                    style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; filter: blur(20px); transform: scale(1.1); transition: opacity 0.3s ease-out;"
                    alt=""
                />
                <img 
                    class="discord-media-image" 
                    src="${dataUrl}" 
                    alt="Image from ${escapeHtml(sender_name)}"
                    loading="lazy"
                    onclick="expandMedia('${messageId}', '${dataUrl}')"
                    onload="this.previousElementSibling.style.opacity = '0'; this.style.opacity = '1';"
                    onerror="handleMediaError('${messageId}', this)"
                    style="position: relative; opacity: 0; transition: opacity 0.3s ease-in; cursor: pointer;"
                />
            </div>
            <div class="media-expand-hint" style="margin-top: 0.5rem; color: #94a3b8; font-size: 0.75rem;">🔍 Click to expand</div>
        `;
    } else if (isVideo) {
        mediaHTML = `
            <video 
                class="discord-media-video" 
                controls 
                preload="metadata"
                style="border-radius: 8px;"
            >
                <source src="${dataUrl}" type="${media_type}">
                Your browser does not support video playback.
            </video>
        `;
    } else if (isAudio) {
        mediaHTML = `
            <audio 
                class="discord-media-audio" 
                controls 
                preload="metadata"
                style="width: 100%;"
            >
                <source src="${dataUrl}" type="${media_type}">
                Your browser does not support audio playback.
            </audio>
        `;
    } else {
        mediaHTML = `
            <div class="media-error">Unsupported media type: ${escapeHtml(media_type)}</div>
        `;
    }
    
    containerEl.innerHTML = mediaHTML;
    console.log(`✅ HTML inserted for message ${messageId}`);
}

// Handle media loading errors with retry
function handleMediaError(messageId, imgElement) {
    console.error(`❌ Image failed to load for message ${messageId}`);
    const retryCount = parseInt(imgElement.dataset.retryCount || '0');
    
    if (retryCount < 2) {
        console.log(`🔄 Retrying image load for message ${messageId} (attempt ${retryCount + 1}/2)...`);
        imgElement.dataset.retryCount = retryCount + 1;
        // Retry by reloading from cache/server
        setTimeout(() => {
            loadMedia(messageId);
        }, 1000 * (retryCount + 1));
    } else {
        imgElement.parentElement.innerHTML = '<div class="media-error" style="padding: 1rem; text-align: center; color: #ef4444; background: rgba(239, 68, 68, 0.1); border-radius: 8px;">Failed to load media after multiple attempts</div>';
    }
}

// Intersection Observer for lazy loading with prefetching
let mediaObserver = null;

function initMediaLazyLoading() {
    // Disconnect existing observer
    if (mediaObserver) {
        mediaObserver.disconnect();
    }
    
    mediaObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const messageId = entry.target.dataset.messageId;
                if (messageId) {
                    console.log(`📸 Loading media for message ${messageId}`);
                    loadMedia(messageId);
                    
                    // Prefetch adjacent messages for smooth scrolling
                    prefetchAdjacentMedia(messageId);
                    
                    // Stop observing once loaded
                    mediaObserver.unobserve(entry.target);
                }
            }
        });
    }, {
        root: null,
        rootMargin: '200px', // Load 200px before entering viewport (increased for prefetch)
        threshold: 0.01
    });
    
    // Observe all media preview elements
    const mediaElements = document.querySelectorAll('.discord-media-preview');
    console.log(`📸 Found ${mediaElements.length} media elements to observe`);
    
    mediaElements.forEach(el => {
        const messageId = el.dataset.messageId;
        const loadingDiv = el.querySelector('.media-loading');
        
        console.log(`📸 Processing media element: messageId=${messageId}, hasLoadingDiv=${!!loadingDiv}`);
        
        // If already loaded (has img/video/audio), skip
        if (!loadingDiv) {
            console.log(`📸 Skipping message ${messageId} - already loaded`);
            return;
        }
        
        console.log(`📸 Observing media element for message ${messageId}`);
        mediaObserver.observe(el);
    });
}

// Prefetch media for adjacent messages (next/previous)
async function prefetchAdjacentMedia(currentMessageId) {
    const allMediaElements = Array.from(document.querySelectorAll('.discord-media-preview'));
    const currentIndex = allMediaElements.findIndex(el => el.dataset.messageId === currentMessageId);
    
    if (currentIndex === -1) return;
    
    // Prefetch next and previous messages
    const adjacentIndices = [
        currentIndex + 1, // Next
        currentIndex - 1, // Previous
        currentIndex + 2  // Next next (for smoother scroll)
    ].filter(i => i >= 0 && i < allMediaElements.length);
    
    for (const index of adjacentIndices) {
        const adjacentEl = allMediaElements[index];
        const adjacentId = adjacentEl.dataset.messageId;
        
        // Only prefetch if not already loaded/loading
        if (adjacentId && adjacentEl.querySelector('.media-loading')) {
            console.log(`🔮 Prefetching media for message ${adjacentId}`);
            
            // Check if already in cache
            const cached = await getCachedMedia(adjacentId);
            if (!cached) {
                // Prefetch in background (don't await)
                fetchMediaFromServer(adjacentId)
                    .then(data => cacheMedia(adjacentId, data))
                    .catch(err => console.warn(`⚠️ Prefetch failed for message ${adjacentId}:`, err));
            }
        }
    }
}

// Expand media in modal
function expandMedia(messageId, dataUrl) {
    const modal = document.createElement('div');
    modal.className = 'media-modal';
    modal.innerHTML = `
        <div class="media-modal-backdrop" onclick="this.parentElement.remove()">
            <div class="media-modal-content" onclick="event.stopPropagation()">
                <button class="media-modal-close" onclick="this.closest('.media-modal').remove()">×</button>
                <img src="${dataUrl}" alt="Expanded media" style="max-width: 90vw; max-height: 90vh; border-radius: 12px;">
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// Helper function (if not already defined globally)
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Export functions for global use
window.initMediaLazyLoading = initMediaLazyLoading;
window.loadMedia = loadMedia;
window.expandMedia = expandMedia;
window.getCachedMedia = getCachedMedia;
window.handleMediaError = handleMediaError;

// Auto-initialize when messages are rendered
document.addEventListener('DOMContentLoaded', () => {
    console.log('📸 Media loader initialized with 90-minute caching');
});
