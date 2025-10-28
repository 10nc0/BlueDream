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

// Fetch media from server using authFetch utility
async function fetchMediaFromServer(messageId) {
    try {
        // Use the global authFetch function
        if (!window.authFetch) {
            throw new Error('authFetch not available - script loading order issue');
        }
        
        console.log(`📥 Fetching media for message ${messageId}...`);
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
        console.error(`❌ Failed to fetch media for message ${messageId}:`, {
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

// Render media element based on type
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
        mediaHTML = `
            <img 
                class="discord-media-image" 
                src="${dataUrl}" 
                alt="Image from ${escapeHtml(sender_name)}"
                loading="lazy"
                onclick="expandMedia('${messageId}', '${dataUrl}')"
                onerror="console.error('❌ Image failed to load for message ${messageId}'); this.parentElement.innerHTML = '<div class=\\'media-error\\'>Image failed to load</div>';"
            />
            <div class="media-expand-hint">🔍 Click to expand</div>
        `;
    } else if (isVideo) {
        mediaHTML = `
            <video 
                class="discord-media-video" 
                controls 
                preload="metadata"
            >
                <source src="${dataUrl}" type="${mimeType}">
                Your browser does not support video playback.
            </video>
        `;
    } else if (isAudio) {
        mediaHTML = `
            <audio 
                class="discord-media-audio" 
                controls 
                preload="metadata"
            >
                <source src="${dataUrl}" type="${mimeType}">
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

// Intersection Observer for lazy loading
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
                    // Stop observing once loaded
                    mediaObserver.unobserve(entry.target);
                }
            }
        });
    }, {
        root: null,
        rootMargin: '100px', // Load 100px before entering viewport
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

// Auto-initialize when messages are rendered
document.addEventListener('DOMContentLoaded', () => {
    console.log('📸 Media loader initialized with 90-minute caching');
});
