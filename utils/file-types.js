const CODE_EXTENSIONS = /\.(js|ts|jsx|tsx|py|go|java|cpp|c|cs|php|rb|rs|swift|sh|bash|sql|html|css|scss|json|yaml|yml|toml|xml|md|vue|svelte|kt|scala|hs|ml|ex|exs|erl|clj|lisp|r|m|asm|wasm)$/i;

const FILE_TYPES = {
    PDF: 'pdf',
    EXCEL: 'excel',
    WORD: 'word',
    PRESENTATION: 'presentation',
    TEXT: 'text',
    IMAGE: 'image',
    AUDIO: 'audio',
    UNKNOWN: 'unknown'
};

function identifyFileType(fileName, mimeType) {
    const ext = (fileName || '').toLowerCase().split('.').pop();
    const mime = (mimeType || '').toLowerCase();

    if (ext === 'pdf' || mime.includes('pdf')) {
        return { type: FILE_TYPES.PDF, extension: ext, mime: mime };
    }
    if (['xlsx', 'xls'].includes(ext) || mime.includes('spreadsheet') || mime.includes('excel')) {
        return { type: FILE_TYPES.EXCEL, extension: ext, mime: mime };
    }
    if (['docx', 'doc'].includes(ext) || mime.includes('word')) {
        return { type: FILE_TYPES.WORD, extension: ext, mime: mime };
    }
    if (['pptx', 'ppt'].includes(ext) || mime.includes('presentation') || mime.includes('powerpoint')) {
        return { type: FILE_TYPES.PRESENTATION, extension: ext, mime: mime };
    }
    if (['txt', 'md', 'csv', 'json', 'xml', 'html'].includes(ext) || mime.includes('text')) {
        return { type: FILE_TYPES.TEXT, extension: ext, mime: mime };
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext) || mime.includes('image')) {
        return { type: FILE_TYPES.IMAGE, extension: ext, mime: mime };
    }
    if (['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac'].includes(ext) || mime.includes('audio')) {
        return { type: FILE_TYPES.AUDIO, extension: ext, mime: mime };
    }

    return { type: FILE_TYPES.UNKNOWN, extension: ext, mime: mime };
}

function detectAttachmentType(filename) {
    if (!filename) return 'unknown';
    const lower = filename.toLowerCase();
    if (lower.match(/\.(xlsx|xls|csv)$/)) return 'spreadsheet';
    if (lower.match(/\.(pdf)$/)) return 'pdf';
    if (lower.match(/\.(doc|docx)$/)) return 'document';
    if (lower.match(/\.(png|jpg|jpeg|gif|webp)$/)) return 'image';
    if (lower.match(/\.(mp3|wav|m4a|ogg)$/)) return 'audio';
    return 'unknown';
}

const AUDIO_MIME_EXT_MAP = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/flac': 'flac' };

module.exports = {
    CODE_EXTENSIONS,
    FILE_TYPES,
    identifyFileType,
    detectAttachmentType,
    AUDIO_MIME_EXT_MAP,
};
