const EMPTY_TABLE_ROW_REGEX = /^[\s\-:]+$/;

function cleanMarkdownJson(str) {
  return str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function parseUserAgent(userAgent) {
    const ua = userAgent || '';
    let deviceType = 'Desktop';
    if (/Mobile|Android|iPhone|iPod/i.test(ua)) deviceType = 'Mobile';
    else if (/iPad|Tablet/i.test(ua)) deviceType = 'Tablet';
    let browser = 'Unknown';
    if (/Edg/i.test(ua)) browser = 'Edge';
    else if (/Chrome/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';
    else if (/MSIE|Trident/i.test(ua)) browser = 'Internet Explorer';
    let os = 'Unknown';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iOS|iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    return { deviceType, browser, os };
}

const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'image/bmp': 'bmp', 'image/tiff': 'tiff',
    'video/mp4': 'mp4', 'video/mpeg': 'mpeg', 'video/quicktime': 'mov',
    'video/x-msvideo': 'avi', 'video/webm': 'webm', 'video/3gpp': '3gp',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg',
    'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/webm': 'weba',
    'audio/aac': 'aac', 'audio/x-m4a': 'm4a',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/x-rar-compressed': 'rar', 'application/x-7z-compressed': '7z',
    'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json',
    'application/xml': 'xml', 'text/html': 'html', 'application/rtf': 'rtf',
    'application/gzip': 'gz', 'application/x-tar': 'tar',
};

function getFileExtension(mimetype) {
    return MIME_TO_EXT[mimetype] || mimetype.split('/').pop().replace(/[^a-z0-9]/gi, '');
}

module.exports = { EMPTY_TABLE_ROW_REGEX, cleanMarkdownJson, parseUserAgent, getFileExtension, MIME_TO_EXT };
