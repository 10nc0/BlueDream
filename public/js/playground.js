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

const MAX_ATTACHMENTS = PLAYGROUND.MAX_ATTACHMENTS;
const MAX_HISTORY_TURNS = PLAYGROUND.MAX_HISTORY_TURNS;
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
    
    // Render all past messages with their attachment metadata and audit data
    conversationHistory.forEach(msg => {
        addMessage(msg.role === 'user' ? 'user' : 'assistant', msg.content, msg.attachments || [], msg.audit || null);
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
    if (currentTimeEl) {
        currentTimeEl.replaceChildren();
        currentTimeEl.appendChild(document.createTextNode(`${year}/${month}/${day}`));
        currentTimeEl.appendChild(document.createElement('br'));
        currentTimeEl.appendChild(document.createTextNode(`${displayHours}:${timeMinutes}:${timeSeconds}${ampm}`));
    }
    
    const currentTimeCompactEl = document.getElementById('currentTimeCompact');
    if (currentTimeCompactEl) {
        currentTimeCompactEl.replaceChildren();
        currentTimeCompactEl.appendChild(document.createTextNode(`${year}/${month}/${day}`));
        currentTimeCompactEl.appendChild(document.createElement('br'));
        currentTimeCompactEl.appendChild(document.createTextNode(`${displayHours}:${timeMinutes}:${timeSeconds}${ampm}`));
    }
}

updateDateTime();
setInterval(updateDateTime, 1000);

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
    attachmentsContainer.replaceChildren();
    
    if (attachments.length === 0) {
        attachmentsContainer.classList.remove('visible');
        return;
    }
    
    attachments.forEach((att, index) => {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        
        const icon = att.type === 'photo' ? '📷' : att.type === 'audio' ? '🎙️' : '📄';
        
        const chipName = document.createElement('span');
        chipName.className = 'chip-name';
        chipName.textContent = `${icon} ${att.name}`;
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-chip';
        removeBtn.dataset.index = index;
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
            removeAttachmentByIndex(index);
        });
        
        chip.appendChild(chipName);
        chip.appendChild(removeBtn);
        
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

function createAuditBadge(auditData) {
    const badgeColors = {
        verified: { bg: 'rgba(34, 197, 94, 0.2)', border: 'rgba(34, 197, 94, 0.4)', icon: '🟢', text: 'Verified' },
        corrected: { bg: 'rgba(234, 179, 8, 0.2)', border: 'rgba(234, 179, 8, 0.4)', icon: '🟡', text: 'Corrected' },
        refused: { bg: 'rgba(239, 68, 68, 0.2)', border: 'rgba(239, 68, 68, 0.4)', icon: '🔴', text: 'Refused' },
        unverified: { bg: 'rgba(148, 163, 184, 0.2)', border: 'rgba(148, 163, 184, 0.4)', icon: '⚪', text: 'Unverified' },
        bypass: { bg: 'rgba(148, 163, 184, 0.2)', border: 'rgba(148, 163, 184, 0.4)', icon: '⚪', text: 'Bypass' }
    };
    const badge = badgeColors[auditData.badge] || badgeColors.unverified;
    const confidence = auditData.confidence || 0;
    const extensions = auditData.extensionsVerified?.join(', ') || 'NYAN';
    
    const badgeEl = document.createElement('div');
    badgeEl.className = 'audit-badge';
    badgeEl.style.cssText = `background: ${badge.bg}; border: 1px solid ${badge.border}; border-radius: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.7rem; display: inline-flex; align-items: center; gap: 0.25rem; margin-bottom: 0.5rem; cursor: pointer;`;
    badgeEl.title = `Confidence: ${confidence}% | Extensions: ${extensions} | Passes: ${auditData.passCount || 1}`;
    
    const iconSpan = document.createElement('span');
    iconSpan.textContent = badge.icon;
    
    const textSpan = document.createElement('span');
    textSpan.textContent = badge.text;
    
    const confSpan = document.createElement('span');
    confSpan.style.opacity = '0.7';
    confSpan.textContent = `(${confidence}%)`;
    
    badgeEl.appendChild(iconSpan);
    badgeEl.appendChild(textSpan);
    badgeEl.appendChild(confSpan);
    
    return badgeEl;
}

function renderMarkdownContent(content) {
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';
    
    if (typeof marked !== 'undefined') {
        try {
            const safeContent = content.replace(/nyan~/g, 'nyan\\~');
            let renderedMarkdown = marked.parse(safeContent, {
                breaks: true,
                gfm: true
            });
            if (typeof DOMPurify !== 'undefined') {
                renderedMarkdown = DOMPurify.sanitize(renderedMarkdown, {
                    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'code', 'pre', 'blockquote', 
                                   'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'hr',
                                   'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'del'],
                    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class'],
                    ALLOW_DATA_ATTR: false
                });
            }
            const parser = new DOMParser();
            const doc = parser.parseFromString(renderedMarkdown, 'text/html');
            while (doc.body.firstChild) {
                contentDiv.appendChild(doc.body.firstChild);
            }
        } catch (err) {
            console.error('Markdown parse error:', err);
            contentDiv.textContent = content;
        }
    } else {
        contentDiv.textContent = content;
    }
    
    return contentDiv;
}

function addMessage(role, content, messageAttachments = [], auditData = null) {
    const welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();
    
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;
    
    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    labelDiv.textContent = role === 'user' ? 'You' : 'Nyan AI';
    msgEl.appendChild(labelDiv);
    
    if (role === 'assistant' && auditData) {
        msgEl.appendChild(createAuditBadge(auditData));
    }
    
    let copyBtn = null;
    if (role === 'assistant') {
        copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.title = 'Copy to clipboard';
        copyBtn.textContent = '📋 Copy';
        msgEl.appendChild(copyBtn);
    }
    
    if (role === 'assistant') {
        msgEl.appendChild(renderMarkdownContent(content));
    } else {
        const contentDiv = document.createElement('div');
        contentDiv.className = 'content';
        contentDiv.textContent = content;
        msgEl.appendChild(contentDiv);
    }
    
    const attList = Array.isArray(messageAttachments) ? messageAttachments : (messageAttachments ? [messageAttachments] : []);
    if (attList.length > 0) {
        const attachmentDiv = document.createElement('div');
        attachmentDiv.className = 'attachment';
        attList.forEach(att => {
            const icon = att.type === 'photo' ? '📷' : att.type === 'audio' ? '🎙️' : '📄';
            const span = document.createElement('span');
            span.style.marginRight = '0.5rem';
            span.textContent = `${icon} ${att.name}`;
            attachmentDiv.appendChild(span);
        });
        msgEl.appendChild(attachmentDiv);
    }
    
    if (copyBtn) {
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

// Animated cat status messages for loading state
const catStatusMessages = [
    { emoji: '🐾', text: 'Purring..' },
    { emoji: '🐱', text: 'Jumping..' },
    { emoji: '😺', text: 'Peeking..' },
    { emoji: '🙀', text: 'Stretching..' },
    { emoji: '😸', text: 'Sniffing..' },
    { emoji: '🐈', text: 'Prowling..' },
    { emoji: '🐈‍⬛', text: 'Thinking..' },
    { emoji: '✨', text: 'Conjuring..' }
];
let loadingAnimationInterval = null;
let loadingMessageIndex = 0;

function addLoadingMessage() {
    // Guard: clear any existing interval before starting new one
    if (loadingAnimationInterval) {
        clearInterval(loadingAnimationInterval);
        loadingAnimationInterval = null;
    }
    
    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant';
    msgEl.id = 'loadingMessage';
    
    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    labelDiv.textContent = 'Nyan AI';
    
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'loading';
    
    const catThinkingDiv = document.createElement('div');
    catThinkingDiv.className = 'cat-thinking';
    catThinkingDiv.id = 'loadingEmoji';
    catThinkingDiv.textContent = '🐾';
    
    const statusSpan = document.createElement('span');
    statusSpan.id = 'loadingStatus';
    statusSpan.style.cssText = 'color: #94a3b8; font-size: 0.875rem;';
    statusSpan.textContent = 'Purring..';
    
    loadingDiv.appendChild(catThinkingDiv);
    loadingDiv.appendChild(statusSpan);
    
    msgEl.appendChild(labelDiv);
    msgEl.appendChild(loadingDiv);
    
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    
    // Start animation cycle
    loadingMessageIndex = 0;
    loadingAnimationInterval = setInterval(() => {
        loadingMessageIndex = (loadingMessageIndex + 1) % catStatusMessages.length;
        const current = catStatusMessages[loadingMessageIndex];
        const emojiEl = document.getElementById('loadingEmoji');
        const statusEl = document.getElementById('loadingStatus');
        if (emojiEl && statusEl) {
            emojiEl.textContent = current.emoji;
            statusEl.textContent = current.text;
        }
    }, 800);
}

function removeLoadingMessage() {
    // Clear animation interval
    if (loadingAnimationInterval) {
        clearInterval(loadingAnimationInterval);
        loadingAnimationInterval = null;
    }
    const loading = document.getElementById('loadingMessage');
    if (loading) loading.remove();
}

let streamingTextBuffer = '';

function addStreamingMessage() {
    const welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();
    
    streamingTextBuffer = '';
    
    // Guard: clear any existing animation interval
    if (loadingAnimationInterval) {
        clearInterval(loadingAnimationInterval);
        loadingAnimationInterval = null;
    }
    
    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant streaming';
    msgEl.id = 'streamingMessage';
    
    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    labelDiv.textContent = 'Nyan AI';
    
    const badgePlaceholder = document.createElement('div');
    badgePlaceholder.className = 'audit-badge-placeholder';
    
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.textContent = '📋 Copy';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content streaming-content';
    
    // Show animated cat loading initially (before first token arrives)
    const loadingContainer = document.createElement('div');
    loadingContainer.id = 'streamingLoadingState';
    loadingContainer.className = 'loading';
    loadingContainer.style.cssText = 'display: flex; align-items: center; gap: 0.75rem;';
    
    const catEmoji = document.createElement('span');
    catEmoji.id = 'streamingCatEmoji';
    catEmoji.className = 'cat-thinking';
    catEmoji.textContent = '🐾';
    
    const statusText = document.createElement('span');
    statusText.id = 'streamingCatStatus';
    statusText.style.cssText = 'color: #94a3b8; font-size: 0.875rem;';
    statusText.textContent = 'Purring..';
    
    loadingContainer.appendChild(catEmoji);
    loadingContainer.appendChild(statusText);
    contentDiv.appendChild(loadingContainer);
    
    const stageBar = document.createElement('div');
    stageBar.id = 'streamingStageBar';
    stageBar.style.cssText = 'display:none; color:#94a3b8; font-size:0.8rem; margin-top:0.35rem; font-style:italic;';

    msgEl.appendChild(labelDiv);
    msgEl.appendChild(badgePlaceholder);
    msgEl.appendChild(copyBtn);
    msgEl.appendChild(contentDiv);
    msgEl.appendChild(stageBar);
    
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    
    // Start animation cycle for cat status messages
    loadingMessageIndex = 0;
    loadingAnimationInterval = setInterval(() => {
        loadingMessageIndex = (loadingMessageIndex + 1) % catStatusMessages.length;
        const current = catStatusMessages[loadingMessageIndex];
        const emojiEl = document.getElementById('streamingCatEmoji');
        const statusEl = document.getElementById('streamingCatStatus');
        if (emojiEl && statusEl) {
            emojiEl.textContent = current.emoji;
            statusEl.textContent = current.text;
        }
    }, 800);
    
    return msgEl;
}

function updateStreamingContent(token) {
    const streamingEl = document.getElementById('streamingMessage');
    if (!streamingEl) return;
    
    const contentEl = streamingEl.querySelector('.streaming-content');
    if (!contentEl) return;
    
    // On first token, clear the cat animation
    if (loadingAnimationInterval) {
        clearInterval(loadingAnimationInterval);
        loadingAnimationInterval = null;
    }
    
    streamingTextBuffer += token;
    
    const textNode = document.createTextNode(streamingTextBuffer);
    const cursorSpan = document.createElement('span');
    cursorSpan.className = 'typing-cursor';
    
    contentEl.replaceChildren();
    contentEl.appendChild(textNode);
    contentEl.appendChild(cursorSpan);
    
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function finalizeStreamingMessage(fullContent, auditData) {
    // Ensure animation is stopped
    if (loadingAnimationInterval) {
        clearInterval(loadingAnimationInterval);
        loadingAnimationInterval = null;
    }
    
    const streamingEl = document.getElementById('streamingMessage');
    if (!streamingEl) return;
    
    streamingEl.classList.remove('streaming');
    const stageBarEl = streamingEl.querySelector('#streamingStageBar');
    if (stageBarEl) stageBarEl.style.display = 'none';
    streamingEl.id = '';
    streamingTextBuffer = '';
    
    const contentEl = streamingEl.querySelector('.streaming-content');
    contentEl.replaceChildren();
    
    if (contentEl && typeof marked !== 'undefined') {
        try {
            const safeContent = fullContent.replace(/nyan~/g, 'nyan\\~');
            let renderedMarkdown = marked.parse(safeContent, { breaks: true, gfm: true });
            if (typeof DOMPurify !== 'undefined') {
                renderedMarkdown = DOMPurify.sanitize(renderedMarkdown, {
                    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'code', 'pre', 'blockquote', 
                                   'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'hr',
                                   'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'del'],
                    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class'],
                    ALLOW_DATA_ATTR: false
                });
            }
            const parser = new DOMParser();
            const doc = parser.parseFromString(renderedMarkdown, 'text/html');
            while (doc.body.firstChild) {
                contentEl.appendChild(doc.body.firstChild);
            }
        } catch (err) {
            contentEl.textContent = fullContent;
        }
    }
    
    if (auditData) {
        const badgePlaceholder = streamingEl.querySelector('.audit-badge-placeholder');
        if (badgePlaceholder) {
            const newBadge = createAuditBadge(auditData);
            badgePlaceholder.parentNode.replaceChild(newBadge, badgePlaceholder);
        }
    }
    
    const copyBtn = streamingEl.querySelector('.copy-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(fullContent);
                copyBtn.textContent = '✓ Copied';
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy';
                    copyBtn.classList.remove('copied');
                }, 2000);
            } catch (err) {
                copyBtn.textContent = '❌ Failed';
                setTimeout(() => copyBtn.textContent = '📋 Copy', 2000);
            }
        });
    }
}

function updateThinkingStage(stage) {
    const streamingEl = document.getElementById('streamingMessage');
    if (!streamingEl) return;
    
    const contentEl = streamingEl.querySelector('.streaming-content');
    if (contentEl && contentEl.textContent.trim() === '') {
        contentEl.replaceChildren();
        const stageSpan = document.createElement('span');
        stageSpan.style.cssText = 'color: #94a3b8; font-size: 0.875rem;';
        stageSpan.textContent = stage;
        const cursorSpan = document.createElement('span');
        cursorSpan.className = 'typing-cursor';
        contentEl.appendChild(stageSpan);
        contentEl.appendChild(cursorSpan);
    } else {
        const stageBar = document.getElementById('streamingStageBar');
        if (stageBar) {
            stageBar.textContent = `🔍 ${stage}`;
            stageBar.style.display = 'block';
        }
    }
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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

async function sendMessage(_retryPayload = null) {
    if (isProcessing) return;

    const isRetry = _retryPayload !== null && !(_retryPayload instanceof Event);

    let message, savedAttachments, payload;

    if (isRetry) {
        payload = _retryPayload;
        message = payload.message || '';
        savedAttachments = [];
        isProcessing = true;
        sendBtn.disabled = true;
    } else {
        message = messageInput.value.trim();
        if (!message && attachments.length === 0) {
            showError('Please enter a message or upload a file.');
            return;
        }

        if (messageInput.blur) messageInput.blur();

        isProcessing = true;
        sendBtn.disabled = true;

        const userMessageText = message || `(Analyzing ${attachments.length} attachment${attachments.length > 1 ? 's' : ''})`;
        addMessage('user', userMessageText, [...attachments]);

        const attachmentMetadata = attachments.map(a => ({ name: a.name, type: a.type }));
        conversationHistory.push({
            role: 'user',
            content: userMessageText,
            attachments: attachmentMetadata.length > 0 ? attachmentMetadata : undefined
        });
        saveConversationHistory();
        messageInput.value = '';
        messageInput.style.height = '44px';

        payload = { message, history: conversationHistory };
        savedAttachments = [...attachments];
        clearAllAttachments();
    }

    if (savedAttachments.length >= 2) {
        try {
            const zipData = await createAttachmentsZip(savedAttachments);
            if (zipData) {
                payload.zipData = zipData;
            } else {
                addUncompressedAttachments(payload, savedAttachments);
            }
        } catch (zipErr) {
            console.error('ZIP creation failed:', zipErr);
            addUncompressedAttachments(payload, savedAttachments);
        }
    } else if (savedAttachments.length === 1) {
        addUncompressedAttachments(payload, savedAttachments);
    }
    
    if (savedAttachments.length === 0 && cachedFileHashes.length > 0) {
        payload.cachedFileHashes = cachedFileHashes;
        console.log(`📂 Sending ${cachedFileHashes.length} cached file hash(es) for follow-up`);
    }
    
    addStreamingMessage();
    
    try {
        const res = await fetch('/api/playground/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) {
            const streamingEl = document.getElementById('streamingMessage');
            if (streamingEl) streamingEl.remove();
            const errorData = await res.json().catch(() => ({}));
            if (res.status === 503 && errorData.code === 'warming_up') {
                addMessage('assistant', '🐱 Still warming up — will retry automatically in 5 seconds...');
                isProcessing = false;
                setTimeout(() => sendMessage(payload), 5000);
            } else {
                addMessage('assistant', errorData.reply || 'An error occurred. Please try again.');
                isProcessing = false;
                sendBtn.disabled = false;
            }
            return;
        }
        
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let auditData = null;
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonStr = line.slice(6).trim();
                    if (!jsonStr || jsonStr === '[DONE]') continue;
                    
                    try {
                        const data = JSON.parse(jsonStr);
                        
                        if (data.type === 'thinking') {
                            updateThinkingStage(data.stage);
                        } else if (data.type === 'audit') {
                            auditData = data.audit;
                        } else if (data.type === 'token') {
                            updateStreamingContent(data.content);
                            fullContent += data.content;
                        } else if (data.type === 'done') {
                            fullContent = data.fullContent || fullContent;
                            finalizeStreamingMessage(fullContent, auditData);
                            
                            conversationHistory.push({ role: 'assistant', content: fullContent, audit: auditData });
                            saveConversationHistory();
                            
                            if (auditData) {
                                console.log(`🌊 Streaming: ${auditData.verdict} (${auditData.confidence}% confidence, ${auditData.passCount} passes)`);
                            }
                        } else if (data.type === 'error') {
                            const streamingEl = document.getElementById('streamingMessage');
                            if (streamingEl) streamingEl.remove();
                            addMessage('assistant', data.message || 'An error occurred.');
                        }
                    } catch (e) {
                        console.warn('SSE parse error:', e);
                    }
                }
            }
        }
        
    } catch (err) {
        console.error('Streaming error:', err);
        const streamingEl = document.getElementById('streamingMessage');
        if (streamingEl) streamingEl.remove();
        const isNetworkError = !navigator.onLine || err.name === 'TypeError' || err.message?.includes('Failed to fetch');
        const errorMsg = isNetworkError
            ? 'Connection lost. Please check your internet and try again.'
            : 'The server encountered an issue. Please try again in a moment.';
        addMessage('assistant', errorMsg);
    }
    
    setTimeout(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 100);
    
    isProcessing = false;
    sendBtn.disabled = false;
    messageInput.focus();
}

// Clear history handler (can be called from UI or console)
async function clearNyanHistory() {
    console.log('🧹 CLEARHISTORY CALLED - Starting conversation clear...');
    
    // Set flag to prevent auto-hydration
    shouldSkipHydration = true;
    
    // 🗑️ NUKE: Call server to clear DataPackage + session (full privacy)
    try {
        const nukeRes = await fetch('/api/playground/nuke', { method: 'DELETE' });
        if (nukeRes.ok) {
            console.log('🗑️ Server session nuked - DataPackage cleared');
        }
    } catch (e) {
        console.warn('⚠️ Server nuke failed (offline?):', e.message);
    }
    
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
    
    const h2 = document.createElement('h2');
    h2.textContent = 'Welcome to Nyan AI Playground';
    
    const p1 = document.createElement('p');
    p1.textContent = 'No login required. No data stored. Just purr intelligence.';
    
    const p2 = document.createElement('p');
    p2.textContent = "Powered by Groq's blazing-fast Llama 3.3 70B. Verified by DeepSeek R1.";
    
    const featuresDiv = document.createElement('div');
    featuresDiv.className = 'features';
    
    const featureData = [
        { icon: '💬', label: 'Text' },
        { icon: '📸', label: 'Photo' },
        { icon: '📎', label: 'Attachment' },
        { icon: '🎙️', label: 'Audio' }
    ];
    
    featureData.forEach(f => {
        const featureDiv = document.createElement('div');
        featureDiv.className = 'feature';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'feature-icon';
        iconSpan.textContent = f.icon;
        const labelDiv = document.createElement('div');
        labelDiv.textContent = f.label;
        featureDiv.appendChild(iconSpan);
        featureDiv.appendChild(labelDiv);
        featuresDiv.appendChild(featureDiv);
    });
    
    welcomeDiv.appendChild(h2);
    welcomeDiv.appendChild(p1);
    welcomeDiv.appendChild(p2);
    welcomeDiv.appendChild(featuresDiv);
    
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
    
    // ===== MOBILE KEYBOARD HANDLER (visualViewport API) =====
    // Fixes iOS keyboard clipping the input bubble
    if (window.visualViewport) {
        const inputContainerEl = document.querySelector('.input-container');
        const messagesAreaEl = document.querySelector('.messages');
        
        function handleViewportResize() {
            if (!inputContainerEl) return;
            
            // Calculate keyboard height (difference between window height and viewport height)
            const keyboardHeight = window.innerHeight - window.visualViewport.height;
            
            if (keyboardHeight > 100) {
                // Keyboard is open - lift input container above keyboard
                inputContainerEl.style.transform = `translateY(-${keyboardHeight}px)`;
                // Also adjust messages area to keep last message visible
                if (messagesAreaEl) {
                    messagesAreaEl.style.paddingBottom = `${120 + keyboardHeight}px`;
                    // Scroll to bottom to keep current view
                    messagesAreaEl.scrollTop = messagesAreaEl.scrollHeight;
                }
            } else {
                // Keyboard is closed - reset
                inputContainerEl.style.transform = 'translateY(0)';
                if (messagesAreaEl) {
                    messagesAreaEl.style.paddingBottom = '';
                }
            }
        }
        
        window.visualViewport.addEventListener('resize', handleViewportResize);
        window.visualViewport.addEventListener('scroll', handleViewportResize);
        console.log('📱 Mobile keyboard handler initialized (visualViewport)');
    }
});
