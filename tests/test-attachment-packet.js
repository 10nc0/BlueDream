/**
 * tests/test-attachment-packet.js
 *
 * Unit tests for lib/attachment-packet.js — the single source of truth for
 * MIME tables, buffer resolution, and list normalisation.
 *
 * All tests run against the real production module so any change to the
 * MIME tables or helper logic is automatically validated here.
 */

'use strict';

const assert = require('assert');

const {
    MIME_FROM_EXT,
    MIME_TO_EXT,
    resolveBuffer,
    deriveMimeFromDoc,
    deriveMimeFromPhoto,
    normalizePhotoList,
    normalizeDocList,
    collectAudioList,
} = require('../lib/attachment-packet');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ ${name}: ${err.message}`);
        failed++;
    }
}

(async () => {

// ── MIME_FROM_EXT table ───────────────────────────────────────────────────────

console.log('\n── MIME_FROM_EXT table ──');

await test('pdf → application/pdf', () => {
    assert.strictEqual(MIME_FROM_EXT['pdf'], 'application/pdf');
});

await test('jpg and jpeg both → image/jpeg', () => {
    assert.strictEqual(MIME_FROM_EXT['jpg'],  'image/jpeg');
    assert.strictEqual(MIME_FROM_EXT['jpeg'], 'image/jpeg');
});

await test('mp3 → audio/mpeg', () => {
    assert.strictEqual(MIME_FROM_EXT['mp3'], 'audio/mpeg');
});

await test('xlsx → correct Office MIME', () => {
    assert.strictEqual(
        MIME_FROM_EXT['xlsx'],
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
});

// ── MIME_TO_EXT table ─────────────────────────────────────────────────────────

console.log('\n── MIME_TO_EXT table ──');

await test('image/jpeg → jpg (preferred alias)', () => {
    assert.strictEqual(MIME_TO_EXT['image/jpeg'], 'jpg');
});

await test('application/pdf → pdf', () => {
    assert.strictEqual(MIME_TO_EXT['application/pdf'], 'pdf');
});

await test('video/mp4 → mp4', () => {
    assert.strictEqual(MIME_TO_EXT['video/mp4'], 'mp4');
});

await test('audio/mpeg → mp3', () => {
    assert.strictEqual(MIME_TO_EXT['audio/mpeg'], 'mp3');
});

await test('MIME_TO_EXT covers every MIME_FROM_EXT value', () => {
    const missing = [];
    for (const mime of Object.values(MIME_FROM_EXT)) {
        if (!MIME_TO_EXT[mime]) missing.push(mime);
    }
    assert.deepStrictEqual(missing, [], `MIME_TO_EXT missing: ${missing.join(', ')}`);
});

// ── resolveBuffer — base64 path ───────────────────────────────────────────────

console.log('\n── resolveBuffer (base64) ──');

await test('raw base64 → correct buffer + filename', async () => {
    const raw = Buffer.from('hello world').toString('base64');
    const result = await resolveBuffer({ base64: raw, mimeType: 'text/plain', prefixName: 'test' });
    assert.ok(result, 'result should not be null');
    assert.ok(result.buffer instanceof Buffer);
    assert.strictEqual(result.buffer.toString(), 'hello world');
    assert.strictEqual(result.mimeType, 'text/plain');
    assert.match(result.filename, /^test_\d+\.txt$/);
});

await test('data-URI prefix is stripped and MIME extracted', async () => {
    const data = Buffer.from('PNG!').toString('base64');
    const dataUri = `data:image/png;base64,${data}`;
    const result = await resolveBuffer({ base64: dataUri, prefixName: 'img' });
    assert.ok(result);
    assert.strictEqual(result.buffer.toString(), 'PNG!');
    assert.strictEqual(result.mimeType, 'image/png');
    assert.match(result.filename, /^img_\d+\.png$/);
});

await test('explicit mimeType overrides data-URI MIME', async () => {
    const data = Buffer.from('data').toString('base64');
    const dataUri = `data:image/jpeg;base64,${data}`;
    const result = await resolveBuffer({ base64: dataUri, mimeType: 'image/webp' });
    assert.strictEqual(result.mimeType, 'image/webp');
});

await test('explicit filename bypasses derivation', async () => {
    const raw = Buffer.from('x').toString('base64');
    const result = await resolveBuffer({ base64: raw, mimeType: 'image/png', filename: 'my-photo.png' });
    assert.strictEqual(result.filename, 'my-photo.png');
});

await test('no source returns null', async () => {
    const result = await resolveBuffer({});
    assert.strictEqual(result, null);
});

await test('fallback to octet-stream when no MIME provided → .bin extension', async () => {
    const raw = Buffer.from('bin').toString('base64');
    const result = await resolveBuffer({ base64: raw });
    assert.strictEqual(result.mimeType, 'application/octet-stream');
    assert.match(result.filename, /\.bin$/, `expected .bin suffix, got: ${result.filename}`);
});

await test('MIME with charset param resolves ext correctly', async () => {
    const raw = Buffer.from('text').toString('base64');
    const result = await resolveBuffer({ base64: raw, mimeType: 'text/plain; charset=utf-8' });
    assert.match(result.filename, /\.txt$/);
});

// ── resolveBuffer — URL path (axios monkey-patched) ──────────────────────────

console.log('\n── resolveBuffer (URL, mocked) ──');

await test('fetches URL and builds correct envelope', async () => {
    const axiosMod = require('axios');
    const origGet = axiosMod.get;
    const fakeBuffer = Buffer.from('fake-image-data');
    axiosMod.get = async () => ({ data: fakeBuffer, headers: { 'content-type': 'image/jpeg' } });
    try {
        const result = await resolveBuffer({ mediaUrl: 'https://example.com/photo.jpg', prefixName: 'twilio' });
        assert.ok(result);
        assert.ok(result.buffer.equals(fakeBuffer));
        assert.strictEqual(result.mimeType, 'image/jpeg');
        assert.match(result.filename, /^twilio_\d+\.jpg$/);
    } finally {
        axiosMod.get = origGet;
    }
});

await test('caller-supplied mimeType takes priority over response header', async () => {
    const axiosMod = require('axios');
    const origGet = axiosMod.get;
    axiosMod.get = async () => ({ data: Buffer.from('data'), headers: { 'content-type': 'application/octet-stream' } });
    try {
        const result = await resolveBuffer({ mediaUrl: 'https://example.com/file', mimeType: 'application/pdf', prefixName: 'doc' });
        assert.strictEqual(result.mimeType, 'application/pdf');
        assert.match(result.filename, /\.pdf$/);
    } finally {
        axiosMod.get = origGet;
    }
});

await test('URL branch retries on transient error and succeeds on second attempt', async () => {
    const axiosMod = require('axios');
    const origGet  = axiosMod.get;
    let attempts = 0;
    axiosMod.get = async () => {
        attempts++;
        if (attempts < 2) {
            const err = new Error('ECONNRESET');
            throw err;  // network error — withRetry should retry
        }
        return { data: Buffer.from('ok'), headers: { 'content-type': 'image/png' } };
    };
    try {
        const result = await resolveBuffer({ mediaUrl: 'https://example.com/img.png', prefixName: 'retry' });
        assert.ok(result, 'should resolve after retry');
        assert.strictEqual(attempts, 2, `expected 2 attempts, got ${attempts}`);
        assert.strictEqual(result.mimeType, 'image/png');
    } finally {
        axiosMod.get = origGet;
    }
});

// ── multi-attachment resolution (agent-pipe scenario) ────────────────────────

console.log('\n── multi-attachment resolution ──');

await test('resolve multiple base64 photos into independent buffer envelopes', async () => {
    const p1 = Buffer.from('photo-1-data').toString('base64');
    const p2 = Buffer.from('photo-2-data').toString('base64');

    const r1 = await resolveBuffer({ base64: p1, mimeType: 'image/jpeg', prefixName: 'photo' });
    const r2 = await resolveBuffer({ base64: p2, mimeType: 'image/png',  prefixName: 'photo' });

    assert.ok(r1 && r2, 'both should resolve');
    assert.strictEqual(r1.buffer.toString(), 'photo-1-data');
    assert.strictEqual(r2.buffer.toString(), 'photo-2-data');
    assert.strictEqual(r1.mimeType, 'image/jpeg');
    assert.strictEqual(r2.mimeType, 'image/png');
    // Filenames must be distinct (timestamp differs or extension differs)
    assert.notStrictEqual(r1.filename, r2.filename);
});

await test('resolve photo and document together preserves both types', async () => {
    const photoB64 = Buffer.from('img-data').toString('base64');
    const docB64   = Buffer.from('pdf-data').toString('base64');

    const [rPhoto, rDoc] = await Promise.all([
        resolveBuffer({ base64: photoB64, mimeType: 'image/jpeg', prefixName: 'photo' }),
        resolveBuffer({ base64: docB64,   mimeType: 'application/pdf', filename: 'report.pdf', prefixName: 'doc' })
    ]);

    assert.strictEqual(rPhoto.mimeType, 'image/jpeg');
    assert.match(rPhoto.filename, /^photo_/);
    assert.strictEqual(rDoc.mimeType, 'application/pdf');
    assert.strictEqual(rDoc.filename, 'report.pdf');
});

// ── deriveMimeFromDoc ─────────────────────────────────────────────────────────

console.log('\n── deriveMimeFromDoc ──');

await test('type token "pdf" → application/pdf', () => {
    assert.strictEqual(deriveMimeFromDoc({ name: 'file.pdf', type: 'pdf' }), 'application/pdf');
});

await test('full MIME in type field passes through', () => {
    assert.strictEqual(deriveMimeFromDoc({ name: 'f', type: 'application/json' }), 'application/json');
});

await test('falls back to filename extension', () => {
    assert.strictEqual(
        deriveMimeFromDoc({ name: 'report.xlsx' }),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
});

await test('unknown extension → null', () => {
    assert.strictEqual(deriveMimeFromDoc({ name: 'file.xyz' }), null);
});

await test('null input → null', () => {
    assert.strictEqual(deriveMimeFromDoc(null), null);
});

// ── deriveMimeFromPhoto ───────────────────────────────────────────────────────

console.log('\n── deriveMimeFromPhoto ──');

await test('string input → image/jpeg', () => {
    assert.strictEqual(deriveMimeFromPhoto('base64string'), 'image/jpeg');
});

await test('type token "png" → image/png', () => {
    assert.strictEqual(deriveMimeFromPhoto({ name: 'img.png', type: 'png' }), 'image/png');
});

await test('filename ext fallback → image/webp', () => {
    assert.strictEqual(deriveMimeFromPhoto({ name: 'shot.webp' }), 'image/webp');
});

await test('unknown extension → image/jpeg default', () => {
    assert.strictEqual(deriveMimeFromPhoto({ name: 'file.xyz' }), 'image/jpeg');
});

// ── normalizePhotoList ────────────────────────────────────────────────────────

console.log('\n── normalizePhotoList ──');

await test('string items get name+type scaffolding', () => {
    const result = normalizePhotoList(['aaa', 'bbb'], null);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, 'photo-0');
    assert.strictEqual(result[0].data, 'aaa');
    assert.strictEqual(result[0].type, 'photo');
    assert.strictEqual(result[1].name, 'photo-1');
});

await test('object items pass through unchanged', () => {
    const item = { name: 'dog.jpg', data: 'xyz', type: 'photo' };
    const result = normalizePhotoList([item], null);
    assert.deepStrictEqual(result[0], item);
});

await test('single photo param appended as "image"', () => {
    const result = normalizePhotoList([], 'single-b64');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'image');
    assert.strictEqual(result[0].data, 'single-b64');
});

await test('empty inputs → empty array', () => {
    assert.deepStrictEqual(normalizePhotoList([], null), []);
    assert.deepStrictEqual(normalizePhotoList(null, null), []);
});

// ── normalizeDocList ──────────────────────────────────────────────────────────

console.log('\n── normalizeDocList ──');

await test('array documents extracted correctly', () => {
    const docs = [{ name: 'a.pdf', data: 'AA==', type: 'pdf' }];
    const result = normalizeDocList(docs, null, null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'a.pdf');
    assert.strictEqual(result[0].data, 'AA==');
});

await test('single document param appended with custom name', () => {
    const result = normalizeDocList([], 'b64data', 'my-doc');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'my-doc');
});

await test('single document defaults to "document" name', () => {
    const result = normalizeDocList([], 'b64data', null);
    assert.strictEqual(result[0].name, 'document');
});

await test('empty inputs → empty array', () => {
    assert.deepStrictEqual(normalizeDocList([], null, null), []);
});

// ── collectAudioList ──────────────────────────────────────────────────────────

console.log('\n── collectAudioList ──');

await test('array items passed through', () => {
    const result = collectAudioList([{ name: 'a.ogg', data: 'x', type: 'audio' }], null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'a.ogg');
});

await test('single audio param appended as voice-recording', () => {
    const result = collectAudioList([], 'rec-b64');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'voice-recording');
    assert.strictEqual(result[0].data, 'rec-b64');
});

await test('empty inputs → empty array', () => {
    assert.deepStrictEqual(collectAudioList([], null), []);
});

// ── backward-compat: agent-pipe-schema re-exports ────────────────────────────

console.log('\n── backward-compat: lib/agent-pipe-schema ──');

await test('MIME_FROM_EXT is same reference as attachment-packet', () => {
    const schema = require('../lib/agent-pipe-schema');
    assert.strictEqual(schema.MIME_FROM_EXT, MIME_FROM_EXT);
});

await test('deriveMimeFromDoc works correctly via schema re-export', () => {
    const { deriveMimeFromDoc: fromSchema } = require('../lib/agent-pipe-schema');
    assert.strictEqual(fromSchema({ name: 'test.pdf' }), 'application/pdf');
});

await test('deriveMimeFromPhoto works correctly via schema re-export', () => {
    const { deriveMimeFromPhoto: fromSchema } = require('../lib/agent-pipe-schema');
    assert.strictEqual(fromSchema('any-string'), 'image/jpeg');
});

// ── backward-compat: routes/nyan-ai/media re-exports ─────────────────────────

console.log('\n── backward-compat: routes/nyan-ai/media ──');

await test('normalizePhotoList is same function reference', () => {
    const media = require('../routes/nyan-ai/media');
    assert.strictEqual(media.normalizePhotoList, normalizePhotoList);
});

await test('normalizeDocList is same function reference', () => {
    const media = require('../routes/nyan-ai/media');
    assert.strictEqual(media.normalizeDocList, normalizeDocList);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);

})();
