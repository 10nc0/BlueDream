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
        // Use the global authFetch function (wait for it to be available)
        if (!window.authFetch) {
            console.warn(`⚠️ authFetch not yet available for message ${messageId} - will retry`);
            // Wait and retry if authFetch isn't loaded yet
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!window.authFetch) {
                throw new Error('authFetch not available after waiting');
            }
        }
        
        console.log(`📥 Fetching media for message ${messageId} (attempt ${retryCount + 1}/${maxRetries + 1})...`);
        const response = await window.authFetch(`/api/messages/${messageId}/media`);
        
        if (!response.ok) {
            const errorText = await response.text();
            
            // 404 means no media attached - this is OK, not an error
            if (response.status === 404) {
                console.log(`ℹ️ No media attached to message ${messageId} - hiding preview`);
                return null; // Return null to indicate "no media" (not an error)
            }
            
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

// Helper to create error div
function createMediaErrorDiv(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'media-error';
    errorDiv.textContent = message;
    return errorDiv;
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
        // DISCORD-FIRST: Check if message has Discord CDN URL (stored in data attribute)
        const mediaUrl = previewEl.dataset.mediaUrl;
        const mediaType = previewEl.dataset.mediaType;
        
        if (mediaUrl) {
            console.log(`🌐 Using Discord CDN URL for message ${messageId}: ${mediaUrl.substring(0, 50)}...`);
            // Render directly from Discord CDN - no server fetch needed
            renderMediaFromUrl(previewEl, messageId, mediaUrl, mediaType);
            console.log(`✅ Media rendered successfully from Discord CDN for message ${messageId}`);
            return;
        }
        
        // Fallback: Legacy path for media stored in PostgreSQL (if any)
        // Check cache first
        let mediaData = await getCachedMedia(messageId);
        
        if (mediaData) {
            console.log(`✅ Using cached media for message ${messageId}`);
        } else {
            console.log(`📡 Fetching media from server for message ${messageId}`);
            // If not cached, fetch from server
            mediaData = await fetchMediaFromServer(messageId);
            
            // If fetchMediaFromServer returns null, it means no media attached (404)
            if (mediaData === null) {
                console.log(`ℹ️ Hiding media preview for message ${messageId} (no media)`);
                previewEl.style.display = 'none'; // Hide the element silently
                return;
            }
            
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
        // Show error message (safe DOM manipulation to prevent XSS)
        const errorDiv = createMediaErrorDiv(`Failed to load media: ${error.message}`);
        previewEl.replaceChildren(errorDiv);
    }
}

// Render media directly from Discord CDN URL
function renderMediaFromUrl(containerEl, messageId, mediaUrl, mediaType) {
    console.log(`🌐 Rendering media from URL for message ${messageId}: ${mediaUrl.substring(0, 50)}...`);
    
    // Determine media category from MIME type
    const normalizedType = (mediaType || '').toLowerCase();
    const isImage = normalizedType.startsWith('image/');
    const isVideo = normalizedType.startsWith('video/');
    const isAudio = normalizedType.startsWith('audio/');
    const isPDF = normalizedType.includes('pdf');
    const isOfficeDoc = normalizedType.includes('word') || normalizedType.includes('document') || 
                        normalizedType.includes('excel') || normalizedType.includes('spreadsheet') ||
                        normalizedType.includes('powerpoint') || normalizedType.includes('presentation');
    
    if (isImage) {
        // Progressive loading with blur placeholder
        const img = document.createElement('img');
        img.alt = `Media from Discord`;
        img.style.width = '100%';
        img.style.maxWidth = '500px';
        img.style.height = 'auto';
        img.style.borderRadius = '8px';
        img.style.cursor = 'pointer';
        img.style.transition = 'filter 0.3s ease-in-out, transform 0.2s ease';
        img.style.filter = 'blur(10px)';
        img.src = generateBlurPlaceholder();
        
        img.onload = () => {
            img.style.filter = 'none';
        };
        
        img.onerror = () => {
            const errorDiv = createMediaErrorDiv('Failed to load image from Discord CDN');
            containerEl.replaceChildren(errorDiv);
        };
        
        // Click to view full size in same page (lightbox effect)
        img.onclick = () => {
            const lightbox = document.createElement('div');
            lightbox.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.9); z-index: 10000; display: flex; align-items: center; justify-content: center; cursor: pointer;';
            
            const fullImg = document.createElement('img');
            fullImg.src = mediaUrl;
            fullImg.style.cssText = 'max-width: 90%; max-height: 90%; border-radius: 8px;';
            
            lightbox.appendChild(fullImg);
            lightbox.onclick = () => document.body.removeChild(lightbox);
            document.body.appendChild(lightbox);
        };
        
        // Set actual URL after placeholder
        setTimeout(() => {
            img.src = mediaUrl;
        }, 50);
        
        containerEl.replaceChildren(img);
        
    } else if (isVideo) {
        const video = document.createElement('video');
        video.controls = true;
        video.style.width = '100%';
        video.style.maxWidth = '600px';
        video.style.borderRadius = '8px';
        video.src = mediaUrl;
        
        video.onerror = () => {
            const errorDiv = createMediaErrorDiv('Failed to load video from Discord CDN');
            containerEl.replaceChildren(errorDiv);
        };
        
        containerEl.replaceChildren(video);
        
    } else if (isAudio) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.style.width = '100%';
        audio.style.maxWidth = '400px';
        audio.src = mediaUrl;
        
        audio.onerror = () => {
            const errorDiv = createMediaErrorDiv('Failed to load audio from Discord CDN');
            containerEl.replaceChildren(errorDiv);
        };
        
        containerEl.replaceChildren(audio);
        
    } else if (isPDF) {
        // Inline PDF viewer using embed
        const pdfContainer = document.createElement('div');
        pdfContainer.style.cssText = 'width: 100%; max-width: 700px; margin: 0.5rem 0;';
        
        const embed = document.createElement('embed');
        embed.src = mediaUrl;
        embed.type = 'application/pdf';
        embed.style.cssText = 'width: 100%; height: 600px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);';
        
        pdfContainer.appendChild(embed);
        
        containerEl.replaceChildren(pdfContainer);
        
    } else if (isOfficeDoc) {
        // Office documents - no preview needed (📎 download button provides access)
        containerEl.replaceChildren();
        containerEl.style.display = 'none'; // Hide preview area entirely
        
    } else {
        // Other files - no preview needed (📎 download button provides access)
        containerEl.replaceChildren();
        containerEl.style.display = 'none'; // Hide preview area entirely
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
        const errorDiv = createMediaErrorDiv('No media data available');
        containerEl.replaceChildren(errorDiv);
        return;
    }
    
    // CRITICAL: Convert Buffer to string if needed (PostgreSQL returns bytea as Buffer)
    let mediaDataString;
    if (typeof media_data === 'object' && media_data.type === 'Buffer' && Array.isArray(media_data.data)) {
        // Convert Buffer array to string using chunking to avoid call stack overflow
        // Process in chunks of 10000 characters to prevent "Maximum call stack size exceeded"
        const chunkSize = 10000;
        const chunks = [];
        for (let i = 0; i < media_data.data.length; i += chunkSize) {
            chunks.push(String.fromCharCode.apply(null, media_data.data.slice(i, i + chunkSize)));
        }
        mediaDataString = chunks.join('');
        console.log(`🔄 Converted Buffer to string for message ${messageId} (${media_data.data.length} bytes in ${chunks.length} chunks)`);
    } else if (typeof media_data === 'string') {
        mediaDataString = media_data;
    } else {
        console.error(`❌ Unknown media_data type for message ${messageId}:`, typeof media_data);
        const errorDiv = createMediaErrorDiv('Invalid media data format');
        containerEl.replaceChildren(errorDiv);
        return;
    }
    
    // Handle both full MIME types (image/jpeg) and legacy simple types (image)
    const normalizedType = (media_type || '').toLowerCase();
    const isImage = normalizedType.startsWith('image/') || normalizedType === 'image';
    const isVideo = normalizedType.startsWith('video/') || normalizedType === 'video';
    const isAudio = normalizedType.startsWith('audio/') || normalizedType === 'audio';
    
    // Check if media_data already has the data: prefix
    let dataUrl;
    if (mediaDataString.startsWith('data:')) {
        // Already has data URL prefix, use as-is
        dataUrl = mediaDataString;
        console.log(`📊 Using existing dataUrl for message ${messageId}: ${dataUrl.substring(0, 100)}... (length: ${dataUrl.length})`);
    } else {
        // Need to add data URL prefix
        let mimeType = media_type;
        if (normalizedType === 'image') mimeType = 'image/jpeg';
        if (normalizedType === 'video') mimeType = 'video/mp4';
        if (normalizedType === 'audio') mimeType = 'audio/mpeg';
        
        dataUrl = `data:${mimeType};base64,${mediaDataString}`;
        console.log(`📊 Generated dataUrl for message ${messageId}: ${dataUrl.substring(0, 100)}... (length: ${dataUrl.length})`);
    }
    
    if (isImage) {
        const blurPlaceholder = generateBlurPlaceholder();
        
        // Create container div
        const containerDiv = document.createElement('div');
        containerDiv.className = 'media-progressive-container';
        containerDiv.style.cssText = 'position: relative; overflow: hidden; border-radius: 8px;';
        
        // Create blur placeholder image
        const placeholderImg = document.createElement('img');
        placeholderImg.className = 'media-blur-placeholder';
        placeholderImg.src = blurPlaceholder;
        placeholderImg.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; filter: blur(20px); transform: scale(1.1); transition: opacity 0.3s ease-out;';
        placeholderImg.alt = '';
        
        // Create main image
        const mainImg = document.createElement('img');
        mainImg.className = 'discord-media-image';
        mainImg.src = dataUrl;
        mainImg.alt = `Image from ${escapeHtml(sender_name)}`;
        mainImg.loading = 'lazy';
        mainImg.dataset.messageId = messageId;
        mainImg.dataset.mediaUrl = dataUrl;
        mainImg.style.cssText = 'position: relative; opacity: 0; transition: opacity 0.3s ease-in; cursor: pointer;';
        
        mainImg.onload = function() {
            placeholderImg.style.opacity = '0';
            mainImg.style.opacity = '1';
        };
        
        mainImg.onerror = function() {
            handleMediaError(messageId, mainImg);
        };
        
        containerDiv.appendChild(placeholderImg);
        containerDiv.appendChild(mainImg);
        
        // Create expand hint
        const hintDiv = document.createElement('div');
        hintDiv.className = 'media-expand-hint';
        hintDiv.style.cssText = 'margin-top: 0.5rem; color: #94a3b8; font-size: 0.75rem;';
        hintDiv.textContent = '🔍 Click to expand';
        
        containerEl.replaceChildren(containerDiv, hintDiv);
        
    } else if (isVideo) {
        const video = document.createElement('video');
        video.className = 'discord-media-video';
        video.controls = true;
        video.preload = 'metadata';
        video.style.borderRadius = '8px';
        
        const source = document.createElement('source');
        source.src = dataUrl;
        source.type = media_type;
        
        video.appendChild(source);
        video.appendChild(document.createTextNode('Your browser does not support video playback.'));
        
        containerEl.replaceChildren(video);
        
    } else if (isAudio) {
        const audio = document.createElement('audio');
        audio.className = 'discord-media-audio';
        audio.controls = true;
        audio.preload = 'metadata';
        audio.style.width = '100%';
        
        const source = document.createElement('source');
        source.src = dataUrl;
        source.type = media_type;
        
        audio.appendChild(source);
        audio.appendChild(document.createTextNode('Your browser does not support audio playback.'));
        
        containerEl.replaceChildren(audio);
        
    } else {
        const errorDiv = createMediaErrorDiv(`Unsupported media type: ${media_type}`);
        containerEl.replaceChildren(errorDiv);
    }
    
    console.log(`✅ Media elements inserted for message ${messageId}`);
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
        const errorDiv = document.createElement('div');
        errorDiv.className = 'media-error';
        errorDiv.style.cssText = 'padding: 1rem; text-align: center; color: #ef4444; background: rgba(239, 68, 68, 0.1); border-radius: 8px;';
        errorDiv.textContent = 'Failed to load media after multiple attempts';
        imgElement.parentElement.replaceChildren(errorDiv);
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
    
    const backdrop = document.createElement('div');
    backdrop.className = 'media-modal-backdrop';
    backdrop.onclick = () => modal.remove();
    
    const content = document.createElement('div');
    content.className = 'media-modal-content';
    content.onclick = (e) => e.stopPropagation();
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'media-modal-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => modal.remove();
    
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Expanded media';
    img.style.cssText = 'max-width: 90vw; max-height: 90vh; border-radius: 12px;';
    
    content.appendChild(closeBtn);
    content.appendChild(img);
    backdrop.appendChild(content);
    modal.appendChild(backdrop);
    document.body.appendChild(modal);
}

// Attach click handlers using event delegation
document.addEventListener('click', function(e) {
    if (e.target.classList.contains('discord-media-image')) {
        const messageId = e.target.dataset.messageId;
        const dataUrl = e.target.dataset.mediaUrl;
        if (messageId && dataUrl) {
            expandMedia(messageId, dataUrl);
        }
    }
});

// Helper function for HTML escaping (pure string-based, no innerHTML)
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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
