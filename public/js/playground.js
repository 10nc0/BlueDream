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
let attachments = [];
let isProcessing = false;
let conversationHistory = [];
let mediaRecorder = null;
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
    if (currentTimeCompactEl) currentTimeCompactEl.textContent = `${year}/${month}/${day} - ${displayHours}:${timeMinutes}:${timeSeconds}${ampm}`;
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
                        name: `recording-${Date.now()}.${ext}`
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
            showError('Microphone access denied. Please check browser permissions.');
            console.error('Microphone error:', err);
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
                addAttachment({
                    type: isImage ? 'photo' : isAudio ? 'audio' : 'document',
                    data: event.target.result,
                    name: file.name
                });
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
            addAttachment({
                type: 'photo',
                data: event.target.result,
                name: `pasted-${Date.now()}.png`
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
    
    const maxSize = file.type.startsWith('image/') ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
    if (file.size > maxSize) {
        showError(`File too large. Max ${file.type.startsWith('image/') ? '5' : '10'}MB.`);
        return;
    }
    
    const reader = new FileReader();
    reader.onload = (event) => {
        addAttachment({
            type: file.type.startsWith('image/') ? 'photo' : 'audio',
            data: event.target.result,
            name: file.name
        });
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
            addAttachment({
                type: isImage ? 'photo' : isAudio ? 'audio' : 'document',
                data: event.target.result,
                name: file.name
            });
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

async function sendMessage() {
    if (isProcessing) return;
    
    const message = messageInput.value.trim();
    if (!message && attachments.length === 0) {
        showError('Please enter a message or upload a file.');
        return;
    }
    
    isProcessing = true;
    sendBtn.disabled = true;
    
    const userMessageText = message || `(Analyzing ${attachments.length} attachment${attachments.length > 1 ? 's' : ''})`;
    addMessage('user', userMessageText, [...attachments]);
    conversationHistory.push({ role: 'user', content: userMessageText });
    messageInput.value = '';
    messageInput.style.height = '44px'; // Reset to min height
    
    // Build payload with arrays for multi-file support
    const payload = { 
        message,
        history: conversationHistory
    };
    
    // Group attachments by type
    const photos = attachments.filter(a => a.type === 'photo').map(a => a.data);
    const audios = attachments.filter(a => a.type === 'audio').map(a => a.data);
    const documents = attachments.filter(a => a.type === 'document').map(a => ({ data: a.data, name: a.name }));
    
    if (photos.length > 0) payload.photos = photos;
    if (audios.length > 0) payload.audios = audios;
    if (documents.length > 0) payload.documents = documents;
    
    // Save attachments snapshot and clear UI
    const savedAttachments = [...attachments];
    clearAllAttachments();
    addLoadingMessage();
    
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
        }
    } catch (err) {
        removeLoadingMessage();
        const reply = 'Connection error. Please check your internet and try again.';
        addMessage('assistant', reply);
    }
    
    isProcessing = false;
    sendBtn.disabled = false;
    messageInput.focus();
}
