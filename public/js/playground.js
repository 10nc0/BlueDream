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
           typeof navigator.mediaDevices.getUserMedia === 'function';
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

// ── URL hint indicator ────────────────────────────────────────────────────────
const urlFetchHint = document.getElementById('urlFetchHint');
const urlHintText  = document.getElementById('urlHintText');
const URL_DETECT_RE = /https?:\/\/[^\s<>"']+/g;

messageInput.addEventListener('input', () => {
    const urls = (messageInput.value.match(URL_DETECT_RE) || []).slice(0, 3);
    if (urls.length === 0) {
        urlFetchHint.classList.remove('visible');
        return;
    }
    const isGitHub = urls.some(u => u.includes('github.com') || u.includes('raw.githubusercontent.com'));
    const label = urls.length === 1
        ? (isGitHub ? 'GitHub repo/file will be read via API' : 'URL will be auto-read')
        : `${urls.length} URLs will be auto-read`;
    urlHintText.textContent = label;
    urlFetchHint.classList.add('visible');
});
// ─────────────────────────────────────────────────────────────────────────────

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
    const confidence = auditData.confidence ?? null;
    const confDisplay = confidence !== null ? `${confidence}%` : '—';
    const extensions = auditData.extensionsVerified?.join(', ') || 'NYAN';
    
    const badgeEl = document.createElement('div');
    badgeEl.className = 'audit-badge';
    badgeEl.style.cssText = `background: ${badge.bg}; border: 1px solid ${badge.border}; border-radius: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.7rem; display: inline-flex; align-items: center; gap: 0.25rem; margin-bottom: 0.5rem; cursor: pointer;`;
    badgeEl.title = `Confidence: ${confDisplay} | Extensions: ${extensions} | Passes: ${auditData.passCount || 1}`;
    
    const iconSpan = document.createElement('span');
    iconSpan.textContent = badge.icon;
    
    const textSpan = document.createElement('span');
    textSpan.textContent = badge.text;
    
    const confSpan = document.createElement('span');
    confSpan.style.opacity = '0.7';
    confSpan.textContent = `(${confDisplay})`;
    
    badgeEl.appendChild(iconSpan);
    badgeEl.appendChild(textSpan);
    badgeEl.appendChild(confSpan);
    
    return badgeEl;
}

// ── Sources footer helpers ────────────────────────────────────────────────────

/**
 * Split content into body + sources string.
 * KEY: regexes are NON-GREEDY on the sources capture so they don't swallow
 * the 🔥 nyan~ signature or anything after the sources block.
 *
 * Format 1 (orchestrator): "📚 **Sources:** item, [Title](URL), item"  — single line
 * Format 2 (LLM bullets):  "**Sources:**\n* [Title](URL)\n* ..."       — consecutive bullet lines
 *
 * Returns { body, sources, format } — format: 'inline' | 'bullets' | null.
 * body always includes the signature (tail after sources block).
 */
function extractSources(content) {
    // Format 1: 📚 **Sources:** — capture only the single line (stop at \n)
    const m1 = content.match(/\n(?:📚\s*)?\*\*Sources:\*\*[ \t]*([^\n]*)/);
    if (m1) {
        return {
            body:    content.slice(0, m1.index) + content.slice(m1.index + m1[0].length),
            sources: m1[1].trim(),
            format:  'inline'
        };
    }

    // Format 2: **Sources:** bullet list — only capture consecutive * / - lines
    const m2 = content.match(/\n\n\*\*Sources:\*\*\n((?:[ \t]*[*\-][^\n]*\n?)+)/);
    if (m2) {
        return {
            body:    content.slice(0, m2.index) + content.slice(m2.index + m2[0].length),
            sources: m2[1].trim(),
            format:  'bullets'
        };
    }

    return { body: content, sources: null, format: null };
}

/**
 * Extract a short brand/site name from a link title + URL.
 *   "Chelsea Scores, Stats and Highlights - ESPN"  → "ESPN"
 *   "Chelsea Results List & Next Game | LiveScore" → "LiveScore"
 *   "Luka Doncic scores 60... - Los Angeles Times" → "Los Angeles Times"
 * Fallback: capitalised root domain (espn.com → Espn).
 */
function extractSourceLabel(title, url) {
    const parts = title.split(/\s*\|\s*|\s+[–—]\s+|\s+-\s+/);
    if (parts.length > 1) {
        const last = parts[parts.length - 1].trim();
        if (last.length > 0 && last.length <= 40) return last;
    }
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        const root = host.split('.')[0];
        return root.charAt(0).toUpperCase() + root.slice(1);
    } catch {
        return title.slice(0, 25);
    }
}

/**
 * Shorten inline body links. Two passes:
 *
 * Pass 1 — List items with **Entity**: pattern
 *   "1. **LiveScore**: prose ... Visit [url](url) for info."
 *   → "1. **[LiveScore](url)**: prose ... Visit livescore.com for info."
 *   The entity name becomes the link; raw inline URLs become plain domain text.
 *
 * Pass 2 — All remaining [Title](URL) links
 *   "[Chelsea Scores – ESPN](url)" → "[ESPN](url)"
 */
function shortenInlineLinks(markdown) {
    // Pass 1: list items that start with **Entity**:
    let out = markdown.replace(
        /^([ \t]*(?:\d+\.|-|\*)\s+)\*\*([^*\n]+)\*\*(\s*:)([^\n]*)/gm,
        (match, bullet, entity, colon, rest) => {
            const urlRe = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
            let firstUrl = null;
            const newRest = rest.replace(urlRe, (_, _title, url) => {
                if (!firstUrl) firstUrl = url;
                try {
                    // Replace with plain domain text (not a link) as a subtle hint
                    return new URL(url).hostname.replace(/^www\./, '');
                } catch { return ''; }
            }).replace(/\s{2,}/g, ' ').trim();
            if (!firstUrl) return match;
            return `${bullet}**[${entity}](${firstUrl})**${colon} ${newRest}`;
        }
    );

    // Pass 2: any remaining [title](url) — shorten to brand name
    out = out.replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_, title, url) =>
        `[${extractSourceLabel(title, url)}](${url})`
    );

    return out;
}

/**
 * Parse a sources block into { type, label, url } items.
 * Handles bullet-list and inline (comma-separated) formats.
 */
function parseSourceItems(sourcesStr, format) {
    const items = [];
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;

    if (format === 'bullets') {
        sourcesStr.split('\n').forEach(line => {
            const stripped = line.replace(/^[ \t]*[*\-]\s*/, '').trim();
            if (!stripped) return;
            const m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(stripped);
            if (m) {
                items.push({ type: 'link', label: extractSourceLabel(m[1].trim(), m[2].trim()), url: m[2].trim() });
            } else if (stripped) {
                items.push({ type: 'text', label: stripped });
            }
        });
    } else {
        let lastIndex = 0, m;
        while ((m = linkRe.exec(sourcesStr)) !== null) {
            const before = sourcesStr.slice(lastIndex, m.index);
            before.split(',').forEach(s => { s = s.trim(); if (s) items.push({ type: 'text', label: s }); });
            items.push({ type: 'link', label: extractSourceLabel(m[1].trim(), m[2].trim()), url: m[2].trim() });
            lastIndex = linkRe.lastIndex;
        }
        sourcesStr.slice(lastIndex).split(',').forEach(s => { s = s.trim(); if (s) items.push({ type: 'text', label: s }); });
    }
    return items;
}

/**
 * Build the sources footer as a prose line:
 *   📚 Sources — ESPN · Los Angeles Times · Sofascore
 * Links are clickable, plain text is muted.
 * Returned element is appended OUTSIDE .content (sibling) to avoid copy-btn overlap.
 */
function renderSourcesFooter(sourcesStr, format) {
    const items = parseSourceItems(sourcesStr, format);
    if (!items.length) return null;

    const footer = document.createElement('div');
    footer.className = 'sources-footer';

    const lbl = document.createElement('span');
    lbl.className = 'sources-label';
    lbl.textContent = '📚 Sources';
    footer.appendChild(lbl);

    const sep0 = document.createElement('span');
    sep0.className = 'sources-sep';
    sep0.textContent = '—';
    footer.appendChild(sep0);

    items.forEach((item, i) => {
        if (i > 0) {
            const dot = document.createElement('span');
            dot.className = 'sources-sep';
            dot.textContent = '·';
            footer.appendChild(dot);
        }
        if (item.type === 'link') {
            const a = document.createElement('a');
            a.className = 'source-link';
            a.href = item.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = item.url;
            a.textContent = item.label;
            footer.appendChild(a);
        } else {
            const span = document.createElement('span');
            span.className = 'source-chip';
            span.textContent = item.label;
            footer.appendChild(span);
        }
    });

    return footer;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render assistant message markdown content.
 * Returns { contentEl, sourcesEl } — append both to the message element,
 * keeping sources OUTSIDE .content so the absolute copy-btn doesn't overlap.
 */
function renderMarkdownContent(content) {
    const { body, sources, format } = extractSources(content);
    const markdownBody = sources !== null ? body : content;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';

    if (typeof marked !== 'undefined') {
        try {
            const shortened = shortenInlineLinks(markdownBody);
            const safeContent = shortened.replace(/nyan~/g, 'nyan\\~');
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
            while (doc.body.firstChild) contentDiv.appendChild(doc.body.firstChild);
        } catch (err) {
            console.error('Markdown parse error:', err);
            contentDiv.textContent = markdownBody;
        }
    } else {
        contentDiv.textContent = markdownBody;
    }

    const sourcesEl = sources !== null ? renderSourcesFooter(sources, format) : null;
    return { contentEl: contentDiv, sourcesEl };
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
        const { contentEl, sourcesEl } = renderMarkdownContent(content);
        msgEl.appendChild(contentEl);
        if (sourcesEl) msgEl.appendChild(sourcesEl);
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
    copyBtn.style.display = 'none';
    
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
    
    msgEl.appendChild(labelDiv);
    msgEl.appendChild(badgePlaceholder);
    msgEl.appendChild(copyBtn);
    msgEl.appendChild(contentDiv);
    
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
    const copyBtnEl = streamingEl.querySelector('.copy-btn');
    if (copyBtnEl) copyBtnEl.style.display = '';
    streamingEl.id = '';
    streamingTextBuffer = '';
    
    const contentEl = streamingEl.querySelector('.streaming-content');
    contentEl.replaceChildren();

    // Delegate to shared renderer — handles shortenInlineLinks + sources split
    const { contentEl: renderedContent, sourcesEl } = renderMarkdownContent(fullContent);
    while (renderedContent.firstChild) contentEl.appendChild(renderedContent.firstChild);

    // Remove any stale sources footer from a previous finalize, then append fresh
    const oldFooter = streamingEl.querySelector('.sources-footer');
    if (oldFooter) oldFooter.remove();
    if (sourcesEl) contentEl.insertAdjacentElement('afterend', sourcesEl);
    
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
    const loadingEl = contentEl && contentEl.querySelector('#streamingLoadingState');

    if (contentEl && contentEl.textContent.trim() === '') {
        // Truly empty — replace with stage text
        contentEl.replaceChildren();
        const stageSpan = document.createElement('span');
        stageSpan.style.cssText = 'color: #94a3b8; font-size: 0.875rem;';
        stageSpan.textContent = stage;
        const cursorSpan = document.createElement('span');
        cursorSpan.className = 'typing-cursor';
        contentEl.appendChild(stageSpan);
        contentEl.appendChild(cursorSpan);
    } else if (loadingEl) {
        // Loading animation still showing — add hint row inside the loading block
        const existing = loadingEl.querySelector('.streaming-stage-hint');
        if (!existing) {
            loadingEl.style.flexDirection = 'column';
            loadingEl.style.alignItems = 'flex-start';
            const hintRow = document.createElement('div');
            hintRow.className = 'streaming-stage-hint';
            hintRow.style.cssText = 'color:#94a3b8; font-size:0.8rem; font-style:italic; padding-top:0.25rem;';
            hintRow.textContent = `🔍 ${stage}`;
            loadingEl.appendChild(hintRow);
        } else {
            existing.textContent = `🔍 ${stage}`;
        }
    } else {
        // Tokens already streamed — append below the draft text, inside contentEl
        const existing = contentEl && contentEl.querySelector('.streaming-stage-hint');
        if (!existing && contentEl) {
            const hint = document.createElement('div');
            hint.className = 'streaming-stage-hint';
            hint.style.cssText = 'color:#94a3b8; font-size:0.8rem; margin-top:0.5rem; font-style:italic;';
            hint.textContent = `🔍 ${stage}`;
            contentEl.appendChild(hint);
        } else if (existing) {
            existing.textContent = `🔍 ${stage}`;
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
        name: a.name,
        source: a.source 
    }));
    const documents = attachmentsList.filter(a => a.type === 'document').map(a => ({ data: a.data, name: a.name }));
    
    if (photos.length > 0) payload.photos = photos;
    if (audios.length > 0) payload.audios = audios;
    if (documents.length > 0) payload.documents = documents;
}

const MAX_WARMUP_RETRIES = 3;

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
        if (urlFetchHint) urlFetchHint.classList.remove('visible');

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
                const retryCount = (payload._retryCount || 0) + 1;
                if (retryCount > MAX_WARMUP_RETRIES) {
                    addMessage('assistant', '🐱 Server is still warming up. Please try again in a moment.');
                    isProcessing = false;
                    sendBtn.disabled = false;
                } else {
                    addMessage('assistant', `🐱 Still warming up — will retry automatically in 5 seconds... (${retryCount}/${MAX_WARMUP_RETRIES})`);
                    isProcessing = false;
                    payload._retryCount = retryCount;
                    setTimeout(() => sendMessage(payload), 5000);
                }
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
    
    try {
        localStorage.removeItem('nyan_history');
        console.log('✅ nyan_history removed');
    } catch (e) {
        console.warn('⚠️ Could not clear localStorage:', e.message);
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
    p2.textContent = "Powered by Groq's blazing-fast Llama 3.3 70B.";
    
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

function _escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function nyanConfirm(message, subtext, onConfirm, danger = true, okLabel = 'Clear') {
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

document.addEventListener('DOMContentLoaded', () => {
    // Populate welcome text with live model label
    fetch('/api/playground/model-info')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!data) return;
            const el = document.getElementById('welcome-model-label');
            if (el) el.textContent = `Groq's blazing-fast ${data.modelLabel}`;
        })
        .catch(() => {});

    // Small delay to ensure all DOM elements are ready
    setTimeout(() => {
        hydrateHistoryToUI();
    }, 100);
    
    // Attach event listener to clear button
    // NOTE: never use confirm() or window.confirm() — blocked in cross-origin iframes.
    // Use nyanConfirm() for all destructive actions.
    const clearBtn = document.querySelector('.clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            nyanConfirm(
                'Clear conversation?',
                'This will erase all messages in this session.',
                () => {
                    console.log('✅ Clear confirmed — resetting session');
                    clearNyanHistory();
                },
                true
            );
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
