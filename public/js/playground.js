const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const photoBtn = document.getElementById('photoBtn');
const audioBtn = document.getElementById('audioBtn');
const photoInput = document.getElementById('photoInput');
const audioInput = document.getElementById('audioInput');
const documentInput = document.getElementById('documentInput');
const attachmentPreview = document.getElementById('attachmentPreview');
const attachmentName = document.getElementById('attachmentName');
const removeAttachment = document.getElementById('removeAttachment');
const errorToast = document.getElementById('errorToast');
const inputContainer = document.querySelector('.input-container');

let currentAttachment = null;
let isProcessing = false;
let conversationHistory = [];

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

photoBtn.addEventListener('click', () => photoInput.click());
audioBtn.addEventListener('click', () => audioInput.click());

photoInput.addEventListener('change', handleFileSelect);
audioInput.addEventListener('change', handleFileSelect);
documentInput.addEventListener('change', handleFileSelect);

removeAttachment.addEventListener('click', clearAttachment);

// ===== DRAG & DROP =====
inputContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    inputContainer.classList.add('drag-over');
});

inputContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    inputContainer.classList.remove('drag-over');
});

inputContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    inputContainer.classList.remove('drag-over');
    
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
        const file = files[0];
        const isImage = file.type.startsWith('image/');
        const isAudio = file.type.startsWith('audio/');
        const isDocument = /\.(pdf|txt|doc|docx|md|rtf)$/i.test(file.name);
        
        if (!isImage && !isAudio && !isDocument) {
            showError('Unsupported file type. Please upload images, audio, or documents (PDF, TXT, DOC, DOCX, MD, RTF).');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (event) => {
            currentAttachment = {
                type: isImage ? 'photo' : isAudio ? 'audio' : 'document',
                data: event.target.result,
                name: file.name
            };
            const icon = isImage ? '📷' : isAudio ? '🎤' : '📄';
            attachmentName.textContent = `${icon} ${file.name}`;
            attachmentPreview.classList.add('visible');
        };
        reader.readAsDataURL(file);
    }
});

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

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
        currentAttachment = {
            type: file.type.startsWith('image/') ? 'photo' : 'audio',
            data: event.target.result,
            name: file.name
        };
        attachmentName.textContent = `${currentAttachment.type === 'photo' ? '📷' : '🔊'} ${file.name}`;
        attachmentPreview.classList.add('visible');
    };
    reader.readAsDataURL(file);
}

function clearAttachment() {
    currentAttachment = null;
    attachmentPreview.classList.remove('visible');
    photoInput.value = '';
    audioInput.value = '';
}

function showError(msg) {
    errorToast.textContent = msg;
    errorToast.classList.add('visible');
    setTimeout(() => errorToast.classList.remove('visible'), 4000);
}

function addMessage(role, content, attachment = null) {
    const welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();
    
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;
    
    let html = `<div class="label">${role === 'user' ? 'You' : 'AI'}</div>`;
    
    // Render markdown for AI responses, plain text for user
    if (role === 'assistant' && typeof marked !== 'undefined') {
        try {
            const renderedMarkdown = marked.parse(content, {
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
    
    if (attachment) {
        const icon = attachment.type === 'photo' ? '📷' : attachment.type === 'audio' ? '🔊' : '📄';
        html += `<div class="attachment">${icon} ${attachment.name}</div>`;
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
        <div class="label">AI</div>
        <div class="loading">
            <div class="loading-dots">
                <span></span><span></span><span></span>
            </div>
            <span style="color: #94a3b8; font-size: 0.875rem;">Thinking...</span>
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
    if (!message && !currentAttachment) {
        showError('Please enter a message or upload a file.');
        return;
    }
    
    isProcessing = true;
    sendBtn.disabled = true;
    
    const userMessageText = message || '(Analyzing attachment)';
    addMessage('user', userMessageText, currentAttachment);
    conversationHistory.push({ role: 'user', content: userMessageText });
    messageInput.value = '';
    
    const payload = { 
        message,
        history: conversationHistory
    };
    if (currentAttachment) {
        if (currentAttachment.type === 'photo') {
            payload.photo = currentAttachment.data;
        } else if (currentAttachment.type === 'audio') {
            payload.audio = currentAttachment.data;
        } else if (currentAttachment.type === 'document') {
            payload.document = currentAttachment.data;
            payload.documentName = currentAttachment.name;
        }
    }
    
    clearAttachment();
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
