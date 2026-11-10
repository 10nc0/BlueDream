'use strict';

const https = require('node:https');
const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const { assertValidSchemaName } = require('../lib/validators');
const { isPrivateIp } = require('../lib/url-fetcher');
const { extractDatePatterns, DEFAULT_TZ } = require('./temporal-resolver');
const MAX_SOURCE = 10 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_PAGES = 3;
const fail = (message, status = 403) => Object.assign(new Error(message), { status });

async function authorizedBook(pool, tenant, bookId, { globalAccess = false } = {}) {
    let schema = assertValidSchemaName(tenant);
    const inferred = require('./audit-context').parseTenantFromBookId(bookId);
    if (inferred && inferred !== schema) {
        if (!globalAccess) throw fail('Book is outside the current tenant.');
        const registry = await pool.query(`SELECT tenant_schema FROM core.book_registry
            WHERE fractal_id=$1 AND tenant_schema=$2`, [String(bookId), inferred]);
        if (!registry.rows.length) throw fail('Book is not registered for authorized global access.');
        schema = assertValidSchemaName(inferred);
    }
    const result = await pool.query(`SELECT id,name,fractal_id,output_credentials,created_at
        FROM ${schema}.books WHERE fractal_id=$1 OR id::text=$1`, [String(bookId)]);
    if (!result.rows.length) throw fail('Book not found.', 404);
    return { ...result.rows[0], tenantSchema: schema };
}
function coordinates(book, msg, attachment, index = 0, source = 'discord') {
    return {
        id: crypto.createHash('sha256').update(`${book.fractal_id}:${source}:${msg.id}:${attachment.id || index}`).digest('hex').slice(0, 24),
        bookId: book.fractal_id, bookName: book.name, messageId: String(msg.id),
        attachmentId: String(attachment.id || index), source,
        timestamp: new Date(msg.createdAt || msg.recorded_at).toISOString(),
        name: attachment.name || 'attachment', mime: attachment.contentType || null,
        size: Number(attachment.size || 0), url: attachment.url, text: msg.content || msg.body || ''
    };
}
function threadId(book) {
    const data = typeof book.output_credentials === 'string' ? JSON.parse(book.output_credentials) : book.output_credentials;
    return data?.output_01?.thread_id;
}
function inScope(value, query, now, tz) {
    const { parseQueryScope, messageMatchesScope } = require('./query-scope');
    const scope = parseQueryScope(query, { now, tz });
    // Missing OCR is not proof an image is irrelevant. Date/sender are metadata;
    // action/entity keywords can rank candidates but cannot remove an empty image.
    return messageMatchesScope({ ...value, sender_name: value.sender, content: value.text },
        { ...scope, actionKeywords: [], plates: [] }, { tz });
}
async function discover({ pool, tenant, bookIds, contextMessages = [], query, now, tz = DEFAULT_TZ, globalAccess = false, sourceLimit = 50 }) {
    const sources = [];
    let scanned = 0;
    let capped = false;
    for (const bookId of bookIds) {
        const book = await authorizedBook(pool, tenant, bookId, { globalAccess });
        const schema = book.tenantSchema;
        const perBookLimit = Math.min(50, Math.max(1, Math.floor(sourceLimit / bookIds.length)));
        const patterns = extractDatePatterns(query, { now, tz });
        const result = await pool.query(`SELECT id,sender_name,body,recorded_at,media_url,attachment_cid
            FROM ${schema}.anatta_messages WHERE book_fractal_id=$1 AND media_url IS NOT NULL
            AND recorded_at >= $2 AND ($3::text[]='{}' OR EXISTS
                (SELECT 1 FROM unnest($3::text[]) p WHERE to_char(recorded_at AT TIME ZONE $4,'YYYY-MM-DD') LIKE p||'%'))
            ORDER BY recorded_at DESC,id DESC LIMIT $5`, [book.fractal_id, book.created_at, patterns, tz, perBookLimit + 1]);
        scanned += result.rows.length;
        if (result.rows.length > perBookLimit) capped = true;
        for (const row of result.rows.slice(0, perBookLimit)) {
            const item = coordinates(book, row, { url: row.media_url }, 0, 'db');
            item.sender = row.sender_name;
            if (inScope(item, query, now, tz)) sources.push(item);
        }
        for (const msg of contextMessages.filter(m => m.bookId === book.fractal_id)) {
            for (const [index, attachment] of (msg.attachments || []).entries()) {
                const item = coordinates(book, { ...msg, createdAt: msg.timestamp }, attachment, index);
                item.sender = msg.sender;
                if (inScope(item, query, now, tz)) sources.push(item);
            }
        }
    }
    // Prefer refreshable, authorized Discord identities to stale database mirrors.
    sources.sort((a, b) => Number(b.source === 'discord') - Number(a.source === 'discord'));
    const seen = new Set();
    const unique = sources.filter(s => {
        // Same stored media URL can appear in both mirrors; preserve attachment identity otherwise.
        let path;
        try { path = new URL(s.url).pathname; } catch { path = s.id; }
        const key = `${s.bookId}:${path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const keywords = require('./audit-context').extractKeywords(query);
    unique.sort((a, b) => {
        const rank = x => keywords.filter(k => `${x.text} ${x.name}`.toLowerCase().includes(k)).length;
        return rank(b) - rank(a) || b.timestamp.localeCompare(a.timestamp);
    });
    return { candidates: unique, capped, scanned };
}
async function resolveSource({ pool, tenant, ref, thothBot, globalAccess = false }) {
    const book = await authorizedBook(pool, tenant, ref.bookId, { globalAccess });
    if (ref.source === 'db') {
        const schema = book.tenantSchema;
        const result = await pool.query(`SELECT id,body,recorded_at,media_url FROM ${schema}.anatta_messages
            WHERE book_fractal_id=$1 AND id::text=$2`, [book.fractal_id, ref.messageId]);
        if (!result.rows.length || !result.rows[0].media_url ||
            new Date(result.rows[0].recorded_at) < new Date(book.created_at)) throw fail('Original attachment unavailable.', 404);
        return coordinates(book, result.rows[0], { url: result.rows[0].media_url }, 0, 'db');
    }
    const thread = threadId(book);
    if (!thread || !thothBot?.ready) throw fail('Original source reader unavailable.', 503);
    const channel = await thothBot.client.channels.fetch(thread);
    const msg = await channel.messages.fetch(ref.messageId);
    if (!msg || String(msg.channelId) !== String(thread) || msg.createdAt < new Date(book.created_at))
        throw fail('Original attachment unavailable.', 404);
    const attachment = msg.attachments.get(ref.attachmentId);
    if (!attachment) throw fail('Original attachment unavailable.', 404);
    return coordinates(book, msg, attachment);
}
function allowedUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
        !url.pathname.startsWith('/attachments/')) throw fail('Attachment source is not an approved media location.');
    return url;
}
async function download(raw, { signal, lookup = dns.lookup } = {}) {
    const url = allowedUrl(raw);
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(a => isPrivateIp(a.address) ||
        /^(?:22[4-9]|23\d|24\d|25[0-5])\./.test(a.address))) throw fail('Unsafe media destination.');
    const chosen = addresses[0];
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            signal, timeout: 10000,
            lookup: (_host, opts, cb) => opts?.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family),
            headers: { Accept: 'image/png,image/jpeg,image/webp,application/pdf' }
        }, res => {
            // CDN refresh uses the authorized Discord API, never arbitrary redirects.
            if (res.statusCode !== 200) { res.resume(); reject(fail('Original unavailable or expired.', 404)); return; }
            if (Number(res.headers['content-length'] || 0) > MAX_SOURCE) { res.destroy(); reject(fail('Attachment exceeds size limit.', 413)); return; }
            const chunks = [];
            let bytes = 0;
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_SOURCE) res.destroy(fail('Attachment exceeds size limit.', 413));
                else chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('timeout', () => req.destroy(fail('Original download timed out.', 504)));
        req.on('error', reject);
    });
}
async function renderLocal(buffer, page = null) {
    // Existing PDF parser includes bounded canvas rendering; no new dependency.
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer, isEvalSupported: false, stopAtErrors: true,
        maxImageSize: 16000000, canvasMaxAreaInBytes: 16 * 1024 * 1024 });
    try {
        const selected = Array.isArray(page) ? page.slice(0, 3) : page ? [page] : [1, 2, 3];
        const info = await parser.getInfo({ partial: selected, parsePageInfo: true });
        if (info.pages.some(p => !p.width || !p.height || p.height / p.width > 4 || p.width / p.height > 4))
            throw fail('Page dimensions cannot be rendered safely and readably.', 413);
        const width = Math.floor(Math.min(...info.pages.map(p => 1200 * Math.min(1, p.width / p.height))));
        if (!width || width < 300) throw fail('Page text cannot be preserved within image limits.', 413);
        const pages = await parser.getScreenshot({ partial: selected, desiredWidth: width,
            imageBuffer: true, imageDataUrl: false });
        return { total: pages.total, images: pages.pages.map(p => ({
            data: Buffer.from(p.data), mime: 'image/png', page: p.pageNumber,
            width: p.width, height: p.height
        })) };
    } finally { await parser.destroy(); }
}
function imageDimensions(buffer) {
    if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let pos = 2;
        while (pos + 4 < buffer.length) {
            if (buffer[pos++] !== 0xff) throw fail('Invalid JPEG.', 415);
            while (buffer[pos] === 0xff) pos++;
            const marker = buffer[pos++];
            if (marker === 0xd9 || marker === 0xda) break;
            const length = buffer.readUInt16BE(pos);
            if (length < 2 || pos + length > buffer.length) break;
            if ([0xc0,0xc1,0xc2].includes(marker)) {
                if (length < 7) break;
                return { width: buffer.readUInt16BE(pos + 5), height: buffer.readUInt16BE(pos + 3) };
            }
            pos += length;
        }
    }
    if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        const kind = buffer.toString('ascii', 12, 16);
        if (kind === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
        if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d,0x01,0x2a])))
            return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
        if (kind === 'VP8L' && buffer[20] === 0x2f) {
            const bits = buffer.readUInt32LE(21);
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
    }
    throw fail('Unsupported or invalid image format; use PNG, JPEG, WEBP, or PDF.', 415);
}
async function decodeImageLocal(buffer) {
    const dimensions = imageDimensions(buffer);
    if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 16000000)
        throw fail('Image dimensions exceed audit limit.', 413);
    const { loadImage, createCanvas } = require('@napi-rs/canvas');
    const image = await loadImage(buffer);
    if (image.width * image.height > 16000000) throw fail('Image dimensions exceed audit limit.', 413);
    const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
    const width = Math.ceil(image.width * scale), height = Math.ceil(image.height * scale);
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return { data: canvas.toBuffer('image/png'), mime: 'image/png', page: 1, width, height };
}
function processMedia(kind, buffer, page, signal) {
    const { Worker } = require('node:worker_threads');
    return new Promise((resolve, reject) => {
        const worker = new Worker(require.resolve('./book-evidence-worker'), {
            workerData: { kind, buffer, page },
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 }
        });
        const timer = setTimeout(() => { worker.terminate(); reject(fail('Media processing timed out.', 504)); }, 10000);
        const abort = () => { finish(); reject(fail('Audit processing cancelled.', 504)); };
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        worker.once('message', result => {
            finish();
            if (result.error) reject(fail(result.error, result.status || 415));
            else {
                if (result.images) result.images.forEach(i => { i.data = Buffer.from(i.data); });
                else result.data = Buffer.from(result.data);
                resolve(result);
            }
        });
        worker.once('error', err => { finish(); reject(err); });
        worker.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(fail('Media processing unavailable.', 503)); } });
    });
}
const render = (buffer, page = null, signal) => processMedia('pdf', buffer, page, signal);
const decodeImage = (buffer, signal) => processMedia('image', buffer, null, signal);
async function prepare(options) {
    const found = await discover(options);
    const images = [], evidence = [], limitations = [];
    let bytes = 0;
    let available = found.candidates.length;
    if (found.capped) limitations.push('Source discovery was capped; the book may contain additional attachments. Narrow the scope.');
    // Only bounded candidates are downloaded; never vision-rank a whole dump.
    for (const ref of found.candidates.slice(0, MAX_PAGES)) {
        if (options.signal?.aborted) throw fail('Audit deadline reached.', 504);
        if (images.length >= MAX_PAGES) break;
        const item = { id: ref.id, bookId: ref.bookId, bookName: ref.bookName, messageId: ref.messageId,
            attachmentId: ref.attachmentId, source: ref.source, status: 'original_unavailable', page: 1 };
        try {
            const fresh = await resolveSource({ ...options, ref });
            const buffer = await download(fresh.url, options);
            bytes += buffer.length;
            if (bytes > MAX_TOTAL) throw fail('Total attachment byte budget exhausted.', 413);
            const pdf = buffer.subarray(0, 5).toString() === '%PDF-';
            const requestedPages = [...String(options.query).matchAll(/\b(?:page|halaman|página)\s*#?(\d{1,5})\b/gi)]
                .map(match => Number(match[1])).filter(page => page > 0 && page <= 10000).slice(0, MAX_PAGES);
            const result = pdf ? await render(buffer, requestedPages.length ? requestedPages : null, options.signal)
                : { total: 1, images: [await decodeImage(buffer, options.signal)] };
            available += Math.max(0, result.total - 1);
            for (const image of result.images.slice(0, MAX_PAGES - images.length)) {
                const id = `${ref.id}-p${image.page}`;
                if (image.data.length > MAX_SOURCE) throw fail('Rendered page exceeds size limit.', 413);
                const citationUrl = `/api/nyan-ai/evidence?bookId=${encodeURIComponent(ref.bookId)}&messageId=${encodeURIComponent(ref.messageId)}&attachmentId=${encodeURIComponent(ref.attachmentId)}&source=${ref.source}&page=${image.page}`;
                const meta = { ...item, id, page: image.page, status: 'selected', citationUrl,
                    hash: crypto.createHash('sha256').update(buffer).digest('hex') };
                evidence.push(meta);
                images.push({ ...image, id, text: fresh.text, meta });
            }
        } catch (err) {
            item.status = err.status === 415 ? 'unsupported' : err.status === 413 ? 'processing_limit' : 'original_unavailable';
            evidence.push(item);
            limitations.push(`${ref.id}: ${err.status === 413 ? 'Attachment exceeds processing limits.' : 'Original unavailable, unreadable, or unsupported.'}`);
        }
    }
    if (available > images.length) limitations.push('Only selected evidence is included; this is not a complete book-image audit.');
    if (!images.length) limitations.push('No readable original images were available for inspection.');
    if (images.reduce((n, i) => n + i.data.length, 0) * 4 / 3 > 8 * 1024 * 1024)
        throw fail('Encoded visual evidence exceeds the audit payload budget.', 413);
    return { images, evidence, available, limitations, capped: found.capped };
}
module.exports = { authorizedBook, discover, resolveSource, allowedUrl, download, render, decodeImage, prepare,
    imageDimensions, renderLocal, decodeImageLocal, inScope };
