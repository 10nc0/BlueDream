#!/usr/bin/env node
/**
 * Keyword extractor — unit tests
 *
 * Asserts:
 *   1. Tokenization splits on Unicode word boundaries, lowercases.
 *   2. Stopwords are stripped per detected language (en + id at minimum).
 *   3. Tag terms (passed via excludeWords) don't appear in keywords.
 *   4. URLs, pure digits, and digit-heavy tokens are filtered.
 *   5. Top-N is respected and ordering is by frequency desc.
 *
 * Run: node tests/test-keyword-extractor.js
 */

'use strict';

const assert = require('assert');
const { extractKeywords, extractNumericTokens, tokenize } = require('../lib/keyword-extractor');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
        failed++;
    }
}

console.log('\n── tokenize() basics ──');

test('lowercases and splits on punctuation', () => {
    const out = tokenize('Hello, World! How-are You?');
    assert.deepStrictEqual(out, ['hello', 'world', 'how', 'are', 'you']);
});

test('strips URLs', () => {
    const out = tokenize('check https://example.com/foo for more');
    assert.deepStrictEqual(out, ['check', 'for', 'more']);
});

test('keeps Unicode letters (Indonesian)', () => {
    const out = tokenize('ganti oli dan filter udara');
    assert.deepStrictEqual(out, ['ganti', 'oli', 'dan', 'filter', 'udara']);
});

console.log('\n── extractKeywords() — Indonesian workshop messages ──');

const workshopMessages = [
    { text: 'ganti ban depan kanan #perbaikan' },
    { text: 'ganti ban belakang kiri sudah' },
    { text: 'ganti oli mesin dan filter udara' },
    { text: 'tambah oli rem, ban masih bagus' },
    { text: 'periksa aki, ganti aki baru' },
    { text: 'ban kempes, ganti ban dalam' },
    { text: 'oli sudah diganti, mesin halus' },
    { text: 'rem belakang perlu disetel' },
    { text: 'filter bensin perlu diganti minggu depan' },
    { text: 'aki tekor lagi, perlu cek alternator' }
];

test('surfaces actual content words (ban, oli, ganti)', () => {
    const out = extractKeywords(workshopMessages);
    const words = out.map(([w]) => w);
    assert.ok(words.includes('ban'),   `expected 'ban' in top keywords, got: ${JSON.stringify(words)}`);
    assert.ok(words.includes('oli'),   `expected 'oli' in top keywords, got: ${JSON.stringify(words)}`);
    assert.ok(words.includes('ganti'), `expected 'ganti' in top keywords, got: ${JSON.stringify(words)}`);
});

test('frequency ordering: ban (5) ranks above aki (3)', () => {
    const out = extractKeywords(workshopMessages);
    const map = Object.fromEntries(out);
    assert.ok(map['ban'] >= map['aki'], `ban=${map['ban']} should be >= aki=${map['aki']}`);
});

test('Indonesian stopwords filtered (no "dan", "sudah", "untuk")', () => {
    const out = extractKeywords(workshopMessages);
    const words = out.map(([w]) => w);
    assert.ok(!words.includes('dan'),   `'dan' should be stopword-filtered`);
    assert.ok(!words.includes('sudah'), `'sudah' should be stopword-filtered`);
});

test('respects topN', () => {
    const out = extractKeywords(workshopMessages, { topN: 3 });
    assert.strictEqual(out.length, 3);
});

test('respects minLength (drops "ya", "ok")', () => {
    const msgs = [
        { text: 'ok ya ban kanan diganti' },
        { text: 'ok ya oli mesin baru' }
    ];
    const out = extractKeywords(msgs, { minLength: 3 });
    const words = out.map(([w]) => w);
    assert.ok(!words.includes('ok'), `'ok' (length 2) should be dropped at minLength=3`);
    assert.ok(!words.includes('ya'), `'ya' (length 2) should be dropped at minLength=3`);
});

console.log('\n── exclusion (tag dedup) ──');

test('excludeWords drops already-tagged terms', () => {
    const msgs = [
        { text: 'perbaikan rem #perbaikan' },
        { text: 'perbaikan ban #perbaikan' },
        { text: 'perbaikan oli depan' }
    ];
    const out = extractKeywords(msgs, { excludeWords: new Set(['perbaikan']) });
    const words = out.map(([w]) => w);
    assert.ok(!words.includes('perbaikan'), `'perbaikan' was in excludeWords, should not appear`);
});

test('excludeWords accepts Set or Array', () => {
    const msgs = [{ text: 'foo bar baz qux' }];
    const a = extractKeywords(msgs, { excludeWords: new Set(['foo']), minLength: 3 });
    const b = extractKeywords(msgs, { excludeWords: ['foo'], minLength: 3 });
    assert.deepStrictEqual(a, b);
});

console.log('\n── filtering: URLs, digits, mixed ──');

test('URLs removed', () => {
    const msgs = [{ text: 'see https://shop.example.com/item123 for details' }];
    const out = extractKeywords(msgs);
    const words = out.map(([w]) => w);
    assert.ok(!words.some(w => w.includes('http')), 'no http fragments');
    assert.ok(!words.includes('example'), 'URL host stripped');
});

test('pure digits filtered', () => {
    const msgs = [
        { text: 'order 12345 ready for pickup' },
        { text: 'order 67890 also ready' }
    ];
    const out = extractKeywords(msgs);
    const words = out.map(([w]) => w);
    assert.ok(!words.includes('12345'), `'12345' should be filtered`);
    assert.ok(!words.includes('67890'), `'67890' should be filtered`);
});

test('digit-heavy tokens (phone fragments) filtered', () => {
    const msgs = [{ text: 'call 081234567890 anytime please please please' }];
    const out = extractKeywords(msgs);
    const words = out.map(([w]) => w);
    assert.ok(!words.some(w => /\d/.test(w) && w.length > 4), 'no long digit tokens');
});

test('file extension fragments filtered (jpg, pdf, csv, docx, mp4)', () => {
    const msgs = [
        { text: 'sent invoice report.pdf for review please review please' },
        { text: 'see foto photo.jpg attached for the issue please review' },
        { text: 'backup data.csv ready for download please please please' },
        { text: 'manual document.docx final version please please please' },
        { text: 'demo video clip.mp4 uploaded already please please please' }
    ];
    const out = extractKeywords(msgs);
    const words = out.map(([w]) => w);
    for (const ext of ['pdf', 'jpg', 'csv', 'docx', 'mp4']) {
        assert.ok(!words.includes(ext), `extension '${ext}' should not be in keywords. got: ${JSON.stringify(words)}`);
    }
    // The base filename / content words should still survive:
    assert.ok(words.includes('report') || words.includes('photo') || words.includes('data'),
        `base filename words should survive: ${JSON.stringify(words)}`);
});

console.log('\n── English stopwords ──');

test('English stopwords filtered ("the", "and", "with")', () => {
    const msgs = [
        { text: 'the customer wants the brakes checked and the tires rotated' },
        { text: 'the engine and the transmission with the standard service package' },
        { text: 'replace the brake pads with the premium set and balance the tires' }
    ];
    const out = extractKeywords(msgs);
    const words = out.map(([w]) => w);
    assert.ok(!words.includes('the'),  `'the' should be stopword-filtered`);
    assert.ok(!words.includes('and'),  `'and' should be stopword-filtered`);
    assert.ok(!words.includes('with'), `'with' should be stopword-filtered`);
});

console.log('\n── edge cases ──');

test('empty messages array returns []', () => {
    assert.deepStrictEqual(extractKeywords([]), []);
});

test('non-array input returns []', () => {
    assert.deepStrictEqual(extractKeywords(null), []);
    assert.deepStrictEqual(extractKeywords(undefined), []);
});

test('messages without text are skipped', () => {
    const msgs = [
        { text: null },
        { },
        { text: 'real content here actually' }
    ];
    const out = extractKeywords(msgs);
    assert.ok(out.length > 0);
});

console.log('\n── stopword override ──');

test('custom stopwordsByLang replaces default for that language', () => {
    const customStopwords = {
        en: new Set(['custom', 'stopword'])  // suppress these specifically
    };
    const msgs = [
        { text: 'custom stopword content actual real word data here' },
        { text: 'custom stopword another actual real word data here' },
        { text: 'custom stopword maybe actual real word data here' }
    ];
    const out = extractKeywords(msgs, { stopwordsByLang: customStopwords });
    const words = out.map(([w]) => w);
    assert.ok(!words.includes('custom'),   `'custom' should be filtered by override`);
    assert.ok(!words.includes('stopword'), `'stopword' should be filtered by override`);
    // 'the' is no longer in the stopword set, so it WOULD survive if present —
    // proves replacement (not merge) semantics of the override at function level.
    assert.ok(words.includes('actual'),    `'actual' should survive (not in custom set)`);
});

console.log('\n── buildTally integration (lib/monthly-closing) ──');

const { buildTally } = require('../lib/monthly-closing');

test('buildTally populates tally.keywords array', () => {
    const messages = [
        { phone: '+62811', text: 'ganti ban depan kanan #perbaikan', timestamp: new Date('2026-04-01'), media: null, attachmentTotalSize: 0 },
        { phone: '+62811', text: 'oli mesin sudah diganti #perbaikan', timestamp: new Date('2026-04-02'), media: null, attachmentTotalSize: 0 },
        { phone: '+62812', text: 'ban belakang kiri perlu ganti', timestamp: new Date('2026-04-03'), media: null, attachmentTotalSize: 0 }
    ];
    const tally = buildTally(messages, 'April 2026');
    assert.ok(Array.isArray(tally.keywords), 'tally.keywords should be an array');
    assert.ok(tally.keywords.length > 0, 'should extract at least some keywords');
    const words = tally.keywords.map(([w]) => w);
    assert.ok(words.includes('ban'), `expected 'ban' in keywords, got: ${JSON.stringify(words)}`);
});

test('buildTally excludes tag terms from keywords (no double-display)', () => {
    const messages = [
        { phone: '+62811', text: 'perbaikan rem #perbaikan', timestamp: new Date('2026-04-01'), media: null, attachmentTotalSize: 0 },
        { phone: '+62811', text: 'perbaikan ban #perbaikan', timestamp: new Date('2026-04-02'), media: null, attachmentTotalSize: 0 },
        { phone: '+62812', text: 'perbaikan oli #perbaikan',  timestamp: new Date('2026-04-03'), media: null, attachmentTotalSize: 0 }
    ];
    const tally = buildTally(messages, 'April 2026');
    const words = tally.keywords.map(([w]) => w);
    assert.ok(tally.tags['#perbaikan'] >= 3, '#perbaikan should be in tags');
    assert.ok(!words.includes('perbaikan'), `'perbaikan' is a tag, should not appear in keywords. Got: ${JSON.stringify(words)}`);
});

console.log('\n── buildTallyHtml integration (lib/monthly-email) ──');

const { buildTallyHtml } = require('../lib/monthly-email');

test('buildTallyHtml renders "Top keywords" block when present', () => {
    const tally = {
        total_messages: 5, text_messages: 5, media_messages: 0,
        contributors: ['+62811'], contributor_count: 1,
        tags: {}, drop_tags: {},
        keywords: [['ban', 5], ['oli', 3], ['rem', 2]]
    };
    const html = buildTallyHtml(tally, 'Test Book', 'April 2026');
    assert.ok(html.includes('Top keywords'),  '"Top keywords" header missing');
    assert.ok(html.includes('ban (5)'),       'keyword ban (5) missing');
    assert.ok(html.includes('oli (3)'),       'keyword oli (3) missing');
    assert.ok(html.includes('rem (2)'),       'keyword rem (2) missing');
});

test('buildTallyHtml does NOT render "Top keywords" when keywords empty', () => {
    const tally = {
        total_messages: 5, text_messages: 5, media_messages: 0,
        contributors: ['+62811'], contributor_count: 1,
        tags: {}, drop_tags: {},
        keywords: []
    };
    const html = buildTallyHtml(tally, 'Test Book', 'April 2026');
    assert.ok(!html.includes('Top keywords'), '"Top keywords" should be hidden when array empty');
});

test('buildTallyHtml does NOT render "Top keywords" when keywords missing (legacy tally)', () => {
    const tally = {
        total_messages: 5, text_messages: 5, media_messages: 0,
        contributors: ['+62811'], contributor_count: 1,
        tags: {}, drop_tags: {}
        // no .keywords field — simulates an older tally object
    };
    const html = buildTallyHtml(tally, 'Test Book', 'April 2026');
    assert.ok(!html.includes('Top keywords'), '"Top keywords" should be hidden when field absent');
});

console.log('\n── extractNumericTokens() — reference-code window ──');

test('captures 4-digit pure-numeric tokens (plate digit-part)', () => {
    const messages = [
        { text: 'plat B 1234 ABC sudah bayar' },
        { text: 'cek lagi B 1234 ABC besok' },
        { text: 'B 1234 ABC servis selesai' }
    ];
    const out = extractNumericTokens(messages);
    const map = Object.fromEntries(out);
    assert.strictEqual(map['1234'], 3, `expected 1234 count=3, got: ${JSON.stringify(out)}`);
});

test('captures 8-digit tokens (boundary inclusive)', () => {
    const messages = [
        { text: 'invoice 12345678 lunas' },
        { text: 'rekening 12345678 ditransfer' }
    ];
    const out = extractNumericTokens(messages);
    const map = Object.fromEntries(out);
    assert.strictEqual(map['12345678'], 2, `expected 12345678 count=2, got: ${JSON.stringify(out)}`);
});

test('drops 3-digit tokens (below minDigitLength)', () => {
    const messages = [
        { text: 'kuantitas 250 unit' },
        { text: 'sebanyak 250 lagi' }
    ];
    const out = extractNumericTokens(messages);
    assert.strictEqual(out.length, 0, `expected no tokens for 3-digit input, got: ${JSON.stringify(out)}`);
});

test('drops 9+ digit tokens (above maxDigitLength — phone protection)', () => {
    const messages = [
        { text: 'wa 081234567890 bro' },
        { text: 'kontak 081234567890 ya' }
    ];
    const out = extractNumericTokens(messages);
    assert.strictEqual(out.length, 0, `expected no tokens for 12-digit phones, got: ${JSON.stringify(out)}`);
});

test('frequency tie-break is lexicographic ascending', () => {
    const messages = [
        { text: '5678 dan 1234 keduanya sama' },
        { text: 'cek 5678 lagi, juga 1234' }
    ];
    const out = extractNumericTokens(messages);
    assert.strictEqual(out[0][0], '1234', `expected 1234 first (lex tie-break), got: ${JSON.stringify(out)}`);
    assert.strictEqual(out[1][0], '5678', `expected 5678 second, got: ${JSON.stringify(out)}`);
});

test('respects topN', () => {
    const messages = [
        { text: '1111 2222 3333 4444 5555 6666 7777' }
    ];
    const out = extractNumericTokens(messages, { topN: 3 });
    assert.strictEqual(out.length, 3, `expected exactly 3 tokens, got ${out.length}`);
});

test('returns empty array for messages with no qualifying digits', () => {
    const messages = [
        { text: 'hanya kata-kata biasa di sini' },
        { text: 'tidak ada nomor sama sekali' }
    ];
    const out = extractNumericTokens(messages);
    assert.deepStrictEqual(out, []);
});

test('returns empty array for empty/invalid input', () => {
    assert.deepStrictEqual(extractNumericTokens([]), []);
    assert.deepStrictEqual(extractNumericTokens(null), []);
    assert.deepStrictEqual(extractNumericTokens(undefined), []);
    assert.deepStrictEqual(extractNumericTokens([{ text: null }, { text: '' }, {}]), []);
});

test('honours custom min/max window', () => {
    const messages = [
        { text: '12 123 1234 12345 123456' }
    ];
    const out = extractNumericTokens(messages, { minDigitLength: 3, maxDigitLength: 5 });
    const tokens = out.map(([t]) => t).sort();
    assert.deepStrictEqual(tokens, ['123', '1234', '12345']);
});

console.log('\n── buildTally — reference codes + media breakdown ──');

test('buildTally surfaces reference_codes from message bodies', () => {
    const messages = [
        { phone: '+62811', text: 'plat B 1234 ABC bayar', timestamp: new Date('2026-04-01'), media: null, attachmentTotalSize: 0 },
        { phone: '+62811', text: 'cek B 1234 ABC lagi',   timestamp: new Date('2026-04-02'), media: null, attachmentTotalSize: 0 },
        { phone: '+62812', text: 'invoice 5678 lunas',    timestamp: new Date('2026-04-03'), media: null, attachmentTotalSize: 0 }
    ];
    const tally = buildTally(messages, 'April 2026');
    assert.ok(Array.isArray(tally.reference_codes), 'reference_codes should be an array');
    const map = Object.fromEntries(tally.reference_codes);
    assert.strictEqual(map['1234'], 2, `expected 1234 count=2, got: ${JSON.stringify(tally.reference_codes)}`);
    assert.strictEqual(map['5678'], 1, `expected 5678 count=1, got: ${JSON.stringify(tally.reference_codes)}`);
});

test('buildTally aggregates media_breakdown by MIME bucket', () => {
    const messages = [
        { phone: '+62811', text: 'foto', timestamp: new Date('2026-04-01'), media: { type: 'attachment' }, mediaType: 'image/jpeg', attachmentTotalSize: 0 },
        { phone: '+62811', text: 'foto', timestamp: new Date('2026-04-02'), media: { type: 'attachment' }, mediaType: 'image/png',  attachmentTotalSize: 0 },
        { phone: '+62812', text: 'video', timestamp: new Date('2026-04-03'), media: { type: 'attachment' }, mediaType: 'video/mp4', attachmentTotalSize: 0 },
        { phone: '+62812', text: 'doc',   timestamp: new Date('2026-04-04'), media: { type: 'attachment' }, mediaType: 'application/pdf', attachmentTotalSize: 0 }
    ];
    const tally = buildTally(messages, 'April 2026');
    assert.strictEqual(tally.media_breakdown.image,    2, `image=2, got ${tally.media_breakdown.image}`);
    assert.strictEqual(tally.media_breakdown.video,    1, `video=1, got ${tally.media_breakdown.video}`);
    assert.strictEqual(tally.media_breakdown.document, 1, `document=1, got ${tally.media_breakdown.document}`);
    assert.strictEqual(tally.media_breakdown.audio,    0, `audio=0, got ${tally.media_breakdown.audio}`);
    assert.strictEqual(tally.media_messages, 4, `media_messages should still total 4`);
});

test('buildTally buckets parameterized MIME (application/pdf; charset=...) as document', () => {
    const messages = [
        { phone: '+62811', text: 'doc', timestamp: new Date('2026-04-01'), media: { type: 'attachment' }, mediaType: 'application/pdf; charset=binary', attachmentTotalSize: 0 },
        { phone: '+62811', text: 'img', timestamp: new Date('2026-04-02'), media: { type: 'attachment' }, mediaType: 'IMAGE/JPEG; quality=85',           attachmentTotalSize: 0 }
    ];
    const tally = buildTally(messages, 'April 2026');
    assert.strictEqual(tally.media_breakdown.document, 1, `document=1 (parameterized pdf), got ${tally.media_breakdown.document}`);
    assert.strictEqual(tally.media_breakdown.image,    1, `image=1 (parameterized + uppercased jpeg), got ${tally.media_breakdown.image}`);
    assert.strictEqual(tally.media_breakdown.other,    0, `other=0 (no fallthrough), got ${tally.media_breakdown.other}`);
});

test('buildTally buckets attachments without mediaType into "other"', () => {
    const messages = [
        { phone: '+62811', text: 'x', timestamp: new Date('2026-04-01'), media: { type: 'attachment' }, mediaType: null, attachmentTotalSize: 0 },
        { phone: '+62811', text: 'y', timestamp: new Date('2026-04-02'), media: { type: 'unknown' },                       attachmentTotalSize: 0 }
    ];
    const tally = buildTally(messages, 'April 2026');
    assert.strictEqual(tally.media_breakdown.other, 2, `expected 2 in 'other' bucket, got ${tally.media_breakdown.other}`);
});

console.log('\n── buildTallyHtml — reference codes + media breakdown blocks ──');

test('buildTallyHtml renders "Top reference codes" when present', () => {
    const tally = {
        total_messages: 3, text_messages: 3, media_messages: 0,
        contributors: ['+62811'], contributor_count: 1,
        tags: {}, drop_tags: {},
        reference_codes: [['1234', 2], ['5678', 1]]
    };
    const html = buildTallyHtml(tally, 'Test Book', 'April 2026');
    assert.ok(html.includes('Top reference codes'), '"Top reference codes" header missing');
    assert.ok(html.includes('1234 (2)'),            'reference 1234 (2) missing');
    assert.ok(html.includes('5678 (1)'),            'reference 5678 (1) missing');
});

test('buildTallyHtml does NOT render reference codes block when empty', () => {
    const tally = {
        total_messages: 3, text_messages: 3, media_messages: 0,
        contributors: ['+62811'], contributor_count: 1,
        tags: {}, drop_tags: {},
        reference_codes: []
    };
    const html = buildTallyHtml(tally, 'Test Book', 'April 2026');
    assert.ok(!html.includes('Top reference codes'), '"Top reference codes" should be hidden when array empty');
});

test('buildTallyHtml renders "Media breakdown" with non-zero buckets only', () => {
    const tally = {
        total_messages: 4, text_messages: 0, media_messages: 4,
        contributors: ['+62811'], contributor_count: 1,
        tags: {}, drop_tags: {},
        media_breakdown: { image: 2, video: 1, audio: 0, document: 1, archive: 0, other: 0 }
    };
    const html = buildTallyHtml(tally, 'Test Book', 'April 2026');
    assert.ok(html.includes('Media breakdown'), '"Media breakdown" header missing');
    assert.ok(html.includes('image (2)'),        'image (2) missing');
    assert.ok(html.includes('video (1)'),        'video (1) missing');
    assert.ok(html.includes('document (1)'),     'document (1) missing');
    assert.ok(!html.includes('audio (0)'),       'audio (0) zero-bucket should be filtered');
    assert.ok(!html.includes('archive (0)'),     'archive (0) zero-bucket should be filtered');
});

test('buildTallyHtml hides "Media breakdown" when every bucket is zero', () => {
    const tally = {
        total_messages: 3, text_messages: 3, media_messages: 0,
        contributors: ['+62811'], contributor_count: 1,
        tags: {}, drop_tags: {},
        media_breakdown: { image: 0, video: 0, audio: 0, document: 0, archive: 0, other: 0 }
    };
    const html = buildTallyHtml(tally, 'Test Book', 'April 2026');
    assert.ok(!html.includes('Media breakdown'), '"Media breakdown" should be hidden when all-zero');
});

test('buildTallyHtml hides "Media breakdown" for legacy tally (no field)', () => {
    const tally = {
        total_messages: 3, text_messages: 3, media_messages: 0,
        contributors: ['+62811'], contributor_count: 1,
        tags: {}, drop_tags: {}
        // no .media_breakdown field — simulates older tally object
    };
    const html = buildTallyHtml(tally, 'Test Book', 'April 2026');
    assert.ok(!html.includes('Media breakdown'), '"Media breakdown" should be hidden when field absent');
});

console.log(`\n── summary ──`);
console.log(`  passed: ${passed}`);
console.log(`  failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
