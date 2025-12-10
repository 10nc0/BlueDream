const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const audioBtn = document.getElementById('audioBtn');
const attachBtn = document.getElementById('attachBtn');
const universalInput = document.getElementById('universalInput');
const audioInput = document.getElementById('audioInput');
const attachmentsContainer = document.getElementById('attachmentsContainer');
const errorToast = document.getElementById('errorToast');
const inputContainer = document.querySelector('.input-container');

const MAX_ATTACHMENTS = 10;
const MAX_HISTORY_TURNS = 8;  // 8 turns = 16 messages (user + assistant)
let attachments = [];
let isProcessing = false;
let conversationHistory = [];
let cachedFileHashes = [];  // Store file hashes for follow-up queries (session-scoped)
let mediaRecorder = null;
let shouldSkipHydration = false;  // Flag to prevent auto-hydration after manual clear

// ===== CONVERSATION MEMORY: localStorage persistence =====
function loadConversationHistory() {
    try {
        const saved = localStorage.getItem('nyan_history');
        if (saved) {
            conversationHistory = JSON.parse(saved);
            console.log(`🧠 Memory: Loaded ${conversationHistory.length} messages from storage`);
        }
    } catch (e) {
        console.warn('⚠️ Could not load conversation history:', e.message);
        conversationHistory = [];
    }
}

function saveConversationHistory() {
    try {
        // Cap at 8 turns (16 messages) to prevent bloat
        if (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
            conversationHistory = conversationHistory.slice(-(MAX_HISTORY_TURNS * 2));
        }
        localStorage.setItem('nyan_history', JSON.stringify(conversationHistory));
    } catch (e) {
        console.warn('⚠️ Could not save conversation history:', e.message);
    }
}

function clearConversationHistory() {
    conversationHistory = [];
    localStorage.removeItem('nyan_history');
    console.log('🧹 Memory: Conversation history cleared');
}

// Hydrate UI from saved history on page load
function hydrateHistoryToUI() {
    if (shouldSkipHydration || conversationHistory.length === 0) return;
    
    // Remove welcome message if restoring history
    const welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();
    
    // Render all past messages with their attachment metadata
    conversationHistory.forEach(msg => {
        addMessage(msg.role === 'user' ? 'user' : 'assistant', msg.content, msg.attachments || []);
    });
    
    console.log(`🧠 Memory: Restored ${conversationHistory.length} messages to UI`);
}

// Load history on page load
loadConversationHistory();
let recordingChunks = [];
let isRecording = false;

// ===== DATE/TIME ANIMATION =====
let lastUpdateSecond = -1;
function updateDateTime() {
    const now = Date.now();
    const currentSecond = Math.floor(now / 1000);
    
    if (currentSecond === lastUpdateSecond) return;
    lastUpdateSecond = currentSecond;
    
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const timeHours = date.getHours();
    const timeMinutes = String(date.getMinutes()).padStart(2, '0');
    const timeSeconds = String(date.getSeconds()).padStart(2, '0');
    const ampm = timeHours >= 12 ? 'PM' : 'AM';
    const displayHours = timeHours % 12 || 12;
    
    const currentTimeEl = document.getElementById('currentTime');
    if (currentTimeEl) currentTimeEl.innerHTML = `${year}/${month}/${day}<br>${displayHours}:${timeMinutes}:${timeSeconds}${ampm}`;
    
    const currentTimeCompactEl = document.getElementById('currentTimeCompact');
    if (currentTimeCompactEl) currentTimeCompactEl.innerHTML = `${year}/${month}/${day}<br>${displayHours}:${timeMinutes}:${timeSeconds}${ampm}`;
}

let dateTimeRafId = null;
function updateDateTimeLoop() {
    updateDateTime();
    dateTimeRafId = requestAnimationFrame(updateDateTimeLoop);
}
updateDateTimeLoop();
updateDateTime();

// Adaptive date/time positioning
const dateTimeDefault = document.getElementById('dateTimeDefault');
const dateTimeCompact = document.getElementById('dateTimeCompact');
const header = document.querySelector('.header');
const COMPACT_THRESHOLD = 65;

function updateDateTimePosition() {
    if (!header || !dateTimeDefault || !dateTimeCompact) return;
    const headerHeight = header.offsetHeight;
    
    if (headerHeight < COMPACT_THRESHOLD) {
        dateTimeDefault.style.display = 'none';
        dateTimeCompact.style.display = 'block';
    } else {
        dateTimeDefault.style.display = 'block';
        dateTimeCompact.style.display = 'none';
    }
}

updateDateTimePosition();
const observer = new MutationObserver(() => updateDateTimePosition());
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
setInterval(() => updateDateTimePosition(), 500);

// Initialize cat animation (from cat-animation.js)
if (typeof initHopAnimation === 'function') {
    initHopAnimation();
}

attachBtn.addEventListener('click', () => universalInput.click());

// ===== MULTI-ATTACHMENT UI =====
function renderAttachments() {
    attachmentsContainer.innerHTML = '';
    
    if (attachments.length === 0) {
        attachmentsContainer.classList.remove('visible');
        return;
    }
    
    attachments.forEach((att, index) => {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        
        const icon = att.type === 'photo' ? '📷' : att.type === 'audio' ? '🎙️' : '📄';
        chip.innerHTML = `
            <span class="chip-name">${icon} ${att.name}</span>
            <button class="remove-chip" data-index="${index}">×</button>
        `;
        
        chip.querySelector('.remove-chip').addEventListener('click', () => {
            removeAttachmentByIndex(index);
        });
        
        attachmentsContainer.appendChild(chip);
    });
    
    // Add count indicator
    const countEl = document.createElement('span');
    countEl.className = 'attachments-count';
    countEl.textContent = `${attachments.length}/${MAX_ATTACHMENTS}`;
    attachmentsContainer.appendChild(countEl);
    
    attachmentsContainer.classList.add('visible');
}

const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total across all files

function getAttachmentSize(attachment) {
    const base64Data = attachment.data.split(',')[1] || '';
    return (base64Data.length * 3) / 4; // Base64 → bytes approximation
}

function getTotalAttachmentSize() {
    return attachments.reduce((sum, att) => sum + getAttachmentSize(att), 0);
}

// Image resizing to save bandwidth and tokens
const MAX_IMAGE_DIMENSION = 2048;
const IMAGE_QUALITY = 0.85; // 85% JPEG quality

function resizeImage(base64Data, callback) {
    const img = new Image();
    
    img.onload = () => {
        // Check if resizing is needed
        if (img.width <= MAX_IMAGE_DIMENSION && img.height <= MAX_IMAGE_DIMENSION) {
            callback(base64Data); // Already small enough
            return;
        }
        
        // Calculate new dimensions (maintain aspect ratio)
        let newWidth = img.width;
        let newHeight = img.height;
        
        if (img.width > MAX_IMAGE_DIMENSION || img.height > MAX_IMAGE_DIMENSION) {
            const ratio = Math.min(MAX_IMAGE_DIMENSION / img.width, MAX_IMAGE_DIMENSION / img.height);
            newWidth = Math.round(img.width * ratio);
            newHeight = Math.round(img.height * ratio);
        }
        
        // Draw to canvas and compress
        const canvas = document.createElement('canvas');
        canvas.width = newWidth;
        canvas.height = newHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, newWidth, newHeight);
        
        // Export as JPEG with quality setting
        const resized = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
        callback(resized);
    };
    
    img.onerror = () => {
        console.error('Failed to load image for resizing');
        callback(base64Data); // Fallback to original
    };
    
    img.src = base64Data;
}

function addAttachment(attachment) {
    if (attachments.length >= MAX_ATTACHMENTS) {
        showError(`Maximum ${MAX_ATTACHMENTS} attachments allowed.`);
        return false;
    }
    
    // Check total size
    const currentTotal = getTotalAttachmentSize();
    const newFileSize = getAttachmentSize(attachment);
    
    if (currentTotal + newFileSize > MAX_TOTAL_SIZE) {
        const totalMB = ((currentTotal + newFileSize) / 1024 / 1024).toFixed(1);
        showError(`Total size (${totalMB}MB) exceeds 50MB limit. Remove some files first.`);
        return false;
    }
    
    attachments.push(attachment);
    renderAttachments();
    return true;
}

function removeAttachmentByIndex(index) {
    attachments.splice(index, 1);
    renderAttachments();
}

function clearAllAttachments() {
    attachments = [];
    renderAttachments();
    if (universalInput) universalInput.value = '';
    if (audioInput) audioInput.value = '';
    // Stop any active recording
    if (isRecording && mediaRecorder) {
        mediaRecorder.stop();
        isRecording = false;
        audioBtn.textContent = '🎙️';
        audioBtn.style.opacity = '1';
    }
}

// Detect supported audio MIME type (Safari uses audio/mp4, others use audio/webm)
function getSupportedAudioMimeType() {
    const types = ['audio/webm', 'audio/mp4', 'audio/ogg'];
    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) {
            return type;
        }
    }
    return 'audio/webm'; // Fallback
}

function getAudioExtension(mimeType) {
    const extensions = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };
    return extensions[mimeType] || 'webm';
}

// Check if browser supports audio recording
function isAudioRecordingSupported() {
    return typeof navigator !== 'undefined' && 
           typeof navigator.mediaDevices !== 'undefined' && 
           typeof navigator.mediaDevices.getUserMedia !== 'function';
}

// Audio recording via microphone
audioBtn.addEventListener('click', async () => {
    if (isRecording) {
        // Stop recording
        mediaRecorder.stop();
        isRecording = false;
        audioBtn.textContent = '🎙️';
        audioBtn.style.opacity = '1';
    } else {
        // Start recording
        try {
            // Check for browser support
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                showError('Voice recording not supported on this browser. Try uploading audio files instead, or use a modern browser on desktop/Android.');
                return;
            }
            
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recordingChunks = [];
            const mimeType = getSupportedAudioMimeType();
            mediaRecorder = new MediaRecorder(stream, { mimeType });
            
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordingChunks.push(event.data);
                }
            };
            
            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(recordingChunks, { type: mimeType });
                const reader = new FileReader();
                const ext = getAudioExtension(mimeType);
                reader.onload = (event) => {
                    addAttachment({
                        type: 'audio',
                        data: event.target.result,
                        name: `recording-${Date.now()}.${ext}`,
                        source: 'recorded'
                    });
                };
                reader.readAsDataURL(audioBlob);
                
                // Stop all tracks
                stream.getTracks().forEach(track => track.stop());
            };
            
            mediaRecorder.start();
            isRecording = true;
            audioBtn.textContent = '⏹️';
            audioBtn.style.opacity = '0.6';
        } catch (err) {
            if (err.name === 'NotAllowedError') {
                showError('Microphone access denied. Check Settings > Privacy > Microphone.');
            } else if (err.name === 'NotFoundError') {
                showError('No microphone found. Please connect a microphone or upload audio files.');
            } else if (err.name === 'NotReadableError') {
                showError('Microphone is in use by another app. Close other apps and try again.');
            } else {
                showError('Microphone error: ' + err.message);
            }
            console.error('🎙️ Microphone error:', err);
        }
    }
});

universalInput.addEventListener('change', handleUniversalFileSelect);
audioInput.addEventListener('change', handleFileSelect);

// ===== DRAG & DROP (FULL PAGE) =====
// Listen for drag over entire document
document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    inputContainer.classList.add('drag-over');
});

// Remove visual feedback when dragging leaves the page
document.addEventListener('dragleave', (e) => {
    // Only remove if we're leaving the document entirely
    if (e.clientX === 0 && e.clientY === 0) {
        inputContainer.classList.remove('drag-over');
    }
});

// Handle file drop anywhere on the page (multi-file support)
document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    inputContainer.classList.remove('drag-over');
    
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
        Array.from(files).forEach(file => {
            if (attachments.length >= MAX_ATTACHMENTS) {
                showError(`Maximum ${MAX_ATTACHMENTS} attachments allowed.`);
                return;
            }
            
            const isImage = file.type.startsWith('image/');
            const isAudio = file.type.startsWith('audio/');
            const isDocument = /\.(pdf|xlsx|xls|txt|doc|docx|md|csv)$/i.test(file.name);
            
            if (!isImage && !isAudio && !isDocument) {
                showError(`Unsupported: ${file.name}. Use images, audio, or documents.`);
                return;
            }
            
            const reader = new FileReader();
            reader.onload = (event) => {
                if (isImage) {
                    // Resize image before adding
                    resizeImage(event.target.result, (resized) => {
                        addAttachment({
                            type: 'photo',
                            data: resized,
                            name: file.name
                        });
                    });
                } else {
                    addAttachment({
                        type: isAudio ? 'audio' : 'document',
                        data: event.target.result,
                        name: file.name,
                        source: isAudio ? 'uploaded' : undefined
                    });
                }
            };
            reader.readAsDataURL(file);
        });
    }
});

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Paste support for clipboard images (Ctrl+V / Cmd+V)
document.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    
    if (imageItem) {
        e.preventDefault();
        const blob = imageItem.getAsFile();
        if (!blob) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            // Resize image before adding
            resizeImage(event.target.result, (resized) => {
                addAttachment({
                    type: 'photo',
                    data: resized,
                    name: `pasted-${Date.now()}.png`
                });
            });
        };
        reader.readAsDataURL(blob);
    }
});

// Auto-resize textarea based on content
function autoResizeTextarea() {
    messageInput.style.height = 'auto';
    const newHeight = Math.min(messageInput.scrollHeight, 200);
    messageInput.style.height = newHeight + 'px';
    // Show scrollbar only when at max height
    messageInput.style.overflowY = messageInput.scrollHeight > 200 ? 'auto' : 'hidden';
}
messageInput.addEventListener('input', autoResizeTextarea);

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const isImage = file.type.startsWith('image/');
    const maxSize = isImage ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
    if (file.size > maxSize) {
        showError(`File too large. Max ${isImage ? '5' : '10'}MB.`);
        return;
    }
    
    const reader = new FileReader();
    reader.onload = (event) => {
        if (isImage) {
            // Resize image before adding
            resizeImage(event.target.result, (resized) => {
                addAttachment({
                    type: 'photo',
                    data: resized,
                    name: file.name
                });
            });
        } else {
            addAttachment({
                type: 'audio',
                data: event.target.result,
                name: file.name,
                source: 'uploaded'
            });
        }
    };
    reader.readAsDataURL(file);
    audioInput.value = '';
}

function handleUniversalFileSelect(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    Array.from(files).forEach(file => {
        if (attachments.length >= MAX_ATTACHMENTS) {
            showError(`Maximum ${MAX_ATTACHMENTS} attachments allowed.`);
            return;
        }
        
        const isImage = file.type.startsWith('image/');
        const isAudio = file.type.startsWith('audio/');
        const isDocument = /\.(pdf|xlsx|xls|txt|doc|docx|md|csv|rtf)$/i.test(file.name);
        
        if (!isImage && !isAudio && !isDocument) {
            showError(`Unsupported: ${file.name}. Use images, audio, or documents.`);
            return;
        }
        
        const maxSize = isImage ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
        if (file.size > maxSize) {
            showError(`${file.name} too large. Max ${isImage ? '5' : '10'}MB.`);
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (event) => {
            if (isImage) {
                // Resize image before adding
                resizeImage(event.target.result, (resized) => {
                    addAttachment({
                        type: 'photo',
                        data: resized,
                        name: file.name
                    });
                });
            } else {
                addAttachment({
                    type: isAudio ? 'audio' : 'document',
                    data: event.target.result,
                    name: file.name,
                    source: isAudio ? 'uploaded' : undefined
                });
            }
        };
        reader.readAsDataURL(file);
    });
    universalInput.value = '';
}

function showError(msg) {
    errorToast.textContent = msg;
    errorToast.classList.add('visible');
    setTimeout(() => errorToast.classList.remove('visible'), 4000);
}

function addMessage(role, content, messageAttachments = []) {
    const welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();
    
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;
    
    let html = `<div class="label">${role === 'user' ? 'You' : 'Nyan AI'}</div>`;
    
    // Add copy button for AI responses
    if (role === 'assistant') {
        html += `<button class="copy-btn" title="Copy to clipboard">📋 Copy</button>`;
    }
    
    // Render markdown for AI responses, plain text for user
    if (role === 'assistant' && typeof marked !== 'undefined') {
        try {
            // Escape tildes in "nyan~" to prevent strikethrough between instances
            const safeContent = content.replace(/nyan~/g, 'nyan\\~');
            const renderedMarkdown = marked.parse(safeContent, {
                breaks: true,
                gfm: true
            });
            html += `<div class="content">${renderedMarkdown}</div>`;
        } catch (err) {
            console.error('Markdown parse error:', err);
            html += `<div class="content">${escapeHtml(content)}</div>`;
        }
    } else {
        html += `<div class="content">${escapeHtml(content)}</div>`;
    }
    
    // Show attachments (support both single and array)
    const attList = Array.isArray(messageAttachments) ? messageAttachments : (messageAttachments ? [messageAttachments] : []);
    if (attList.length > 0) {
        html += '<div class="attachment">';
        attList.forEach(att => {
            const icon = att.type === 'photo' ? '📷' : att.type === 'audio' ? '🎙️' : '📄';
            html += `<span style="margin-right: 0.5rem;">${icon} ${att.name}</span>`;
        });
        html += '</div>';
    }
    
    msgEl.innerHTML = html;
    
    // Add click handler for copy button
    if (role === 'assistant') {
        const copyBtn = msgEl.querySelector('.copy-btn');
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(content);
                copyBtn.textContent = '✓ Copied';
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy';
                    copyBtn.classList.remove('copied');
                }, 2000);
            } catch (err) {
                console.error('Copy failed:', err);
                copyBtn.textContent = '❌ Failed';
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy';
                }, 2000);
            }
        });
    }
    
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    
    return msgEl;
}

function addLoadingMessage() {
    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant';
    msgEl.id = 'loadingMessage';
    msgEl.innerHTML = `
        <div class="label">Nyan AI</div>
        <div class="loading">
            <div class="cat-thinking">🐾</div>
            <span style="color: #94a3b8; font-size: 0.875rem;">Purring over your query...</span>
        </div>
    `;
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeLoadingMessage() {
    const loading = document.getElementById('loadingMessage');
    if (loading) loading.remove();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Create ZIP from multiple attachments for bandwidth optimization
async function createAttachmentsZip(attachmentsList) {
    if (typeof JSZip === 'undefined') {
        console.warn('JSZip not loaded, sending uncompressed');
        return null;
    }
    
    const zip = new JSZip();
    const manifest = [];
    
    attachmentsList.forEach((att, index) => {
        // Extract base64 data (remove data URL prefix)
        const base64Match = att.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!base64Match) return;
        
        const mimeType = base64Match[1];
        const base64Data = base64Match[2];
        const ext = att.name.split('.').pop() || 'bin';
        const filename = `${index}_${att.name}`;
        
        // Add file to ZIP
        zip.file(filename, base64Data, { base64: true });
        
        // Track metadata for server-side reconstruction
        manifest.push({
            filename,
            type: att.type,
            originalName: att.name,
            mimeType,
            source: att.source
        });
    });
    
    // Add manifest for server to reconstruct attachments
    zip.file('manifest.json', JSON.stringify(manifest));
    
    // Generate ZIP as base64
    const zipBlob = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
    return zipBlob;
}

// Helper to add attachments without ZIP (single file or fallback)
function addUncompressedAttachments(payload, attachmentsList) {
    const photos = attachmentsList.filter(a => a.type === 'photo').map(a => a.data);
    const audios = attachmentsList.filter(a => a.type === 'audio').map(a => ({ 
        data: a.data, 
        source: a.source 
    }));
    const documents = attachmentsList.filter(a => a.type === 'document').map(a => ({ data: a.data, name: a.name }));
    
    if (photos.length > 0) payload.photos = photos;
    if (audios.length > 0) payload.audios = audios;
    if (documents.length > 0) payload.documents = documents;
}

async function sendMessage() {
    if (isProcessing) return;
    
    const message = messageInput.value.trim();
    if (!message && attachments.length === 0) {
        showError('Please enter a message or upload a file.');
        return;
    }
    
    // Auto-collapse keyboard on mobile (Android UX improvement)
    if (messageInput.blur) {
        messageInput.blur();
    }
    
    isProcessing = true;
    sendBtn.disabled = true;
    
    const userMessageText = message || `(Analyzing ${attachments.length} attachment${attachments.length > 1 ? 's' : ''})`;
    addMessage('user', userMessageText, [...attachments]);
    
    // Store message with attachment metadata for context retention
    const attachmentMetadata = attachments.map(a => ({
        name: a.name,
        type: a.type
    }));
    conversationHistory.push({ 
        role: 'user', 
        content: userMessageText,
        attachments: attachmentMetadata.length > 0 ? attachmentMetadata : undefined
    });
    saveConversationHistory();  // Persist immediately after user message
    messageInput.value = '';
    messageInput.style.height = '44px'; // Reset to min height
    
    // Build payload with arrays for multi-file support
    const payload = { 
        message,
        history: conversationHistory
    };
    
    // Save attachments snapshot and clear UI early
    const savedAttachments = [...attachments];
    clearAllAttachments();
    addLoadingMessage();
    
    // Use ZIP for 2+ attachments (bandwidth optimization)
    if (savedAttachments.length >= 2) {
        try {
            const zipData = await createAttachmentsZip(savedAttachments);
            if (zipData) {
                payload.zipData = zipData;
            } else {
                // Fallback to uncompressed if ZIP fails
                addUncompressedAttachments(payload, savedAttachments);
            }
        } catch (zipErr) {
            console.error('ZIP creation failed:', zipErr);
            addUncompressedAttachments(payload, savedAttachments);
        }
    } else if (savedAttachments.length === 1) {
        // Single file - no ZIP overhead
        addUncompressedAttachments(payload, savedAttachments);
    }
    
    // Include cached file hashes for follow-up queries (no need to re-upload)
    if (savedAttachments.length === 0 && cachedFileHashes.length > 0) {
        payload.cachedFileHashes = cachedFileHashes;
        console.log(`📂 Sending ${cachedFileHashes.length} cached file hash(es) for follow-up`);
    }
    
    try {
        const res = await fetch('/api/playground', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        removeLoadingMessage();
        
        const data = await res.json();
        
        if (!res.ok) {
            const reply = data.reply || 'An error occurred. Please try again.';
            addMessage('assistant', reply);
        } else {
            const reply = data.reply;
            addMessage('assistant', reply);
            conversationHistory.push({ role: 'assistant', content: reply });
            saveConversationHistory();  // Persist to localStorage
            
            // Store file hashes for follow-up queries (session-scoped attachment retention)
            if (data.cachedFileHashes && data.cachedFileHashes.length > 0) {
                cachedFileHashes = data.cachedFileHashes;
                console.log(`📂 Stored ${cachedFileHashes.length} file hash(es) for follow-up queries`);
            }
        }
        
        // Enrich history payload with attachment metadata for next turn
        if (conversationHistory.length > 0) {
            payload.contextAttachments = conversationHistory
                .filter(msg => msg.attachments)
                .map((msg, idx) => ({
                    messageIndex: idx,
                    attachments: msg.attachments
                }));
        }
    } catch (err) {
        removeLoadingMessage();
        const reply = 'Connection error. Please check your internet and try again.';
        addMessage('assistant', reply);
    }
    
    // Auto-scroll to bottom after assistant reply
    setTimeout(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 100);
    
    isProcessing = false;
    sendBtn.disabled = false;
    messageInput.focus();
}

// Clear history handler (can be called from UI or console)
function clearNyanHistory() {
    console.log('🧹 CLEARHISTORY CALLED - Starting conversation clear...');
    alert('🧹 Clearing conversation...');  // Visual feedback so you know it worked
    
    // Set flag to prevent auto-hydration
    shouldSkipHydration = true;
    
    // Clear in-memory arrays
    conversationHistory = [];
    attachments = [];
    cachedFileHashes = [];  // Clear cached file hashes too
    
    // Clear localStorage completely
    try {
        localStorage.clear();
        console.log('✅ localStorage cleared');
    } catch (e) {
        console.warn('⚠️ localStorage.clear() failed:', e.message);
        try {
            localStorage.removeItem('nyan_history');
            console.log('✅ nyan_history removed');
        } catch (e2) {
            console.error('❌ Could not clear localStorage:', e2.message);
        }
    }
    
    // Explicitly remove all child nodes from messages container
    while (messagesEl.firstChild) {
        messagesEl.removeChild(messagesEl.firstChild);
    }
    console.log('✅ All DOM children removed');
    
    // Create and append fresh welcome message
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'welcome';
    welcomeDiv.innerHTML = `
        <h2>Welcome to Nyan AI Playground</h2>
        <p>No login required. No data stored. Just purr intelligence.</p>
        <p>Powered by Groq's blazing-fast Llama 3.3 70B model.</p>
        <div class="features">
            <div class="feature"><span class="feature-icon">💬</span><div>Text</div></div>
            <div class="feature"><span class="feature-icon">📸</span><div>Photo</div></div>
            <div class="feature"><span class="feature-icon">📎</span><div>Attachment</div></div>
            <div class="feature"><span class="feature-icon">🎙️</span><div>Audio</div></div>
        </div>
    `;
    messagesEl.appendChild(welcomeDiv);
    console.log('✅ Welcome message re-added');
    
    // Clear attachments UI
    clearAllAttachments();
    
    // Reset message input
    messageInput.value = '';
    messageInput.style.height = '44px';
    
    // Reset processing state
    isProcessing = false;
    sendBtn.disabled = false;
    
    console.log('🧹 Conversation cleared - fresh start! State completely reset.');
}

// Hydrate history to UI after DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure all DOM elements are ready
    setTimeout(() => {
        hydrateHistoryToUI();
    }, 100);
    
    // Attach event listener to clear button
    const clearBtn = document.querySelector('.clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (confirm('Start a new conversation? This will clear your chat history.')) {
                console.log('✅ Clear button confirmed via event listener');
                clearNyanHistory();
            }
        });
        console.log('✅ Event listener attached to clear button');
    } else {
        console.error('❌ Clear button not found in DOM');
    }
});
