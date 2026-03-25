#!/usr/bin/env node
/**
 * Message Capsule Integrity Tests — standalone, no live server required.
 *
 * Tests the cryptographic guarantees of buildCapsule():
 *   - SHA256 content hash determinism and non-collision
 *   - HMAC sender proof determinism and non-collision
 *   - Required fields present on every capsule
 *   - Schema version field (v) present for migration forward-compat
 *
 * Run: node tests/test-capsule.js
 */

'use strict';

// Set fixed test salt BEFORE requiring message-capsule (module reads env at load time)
process.env.FRACTAL_SALT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const { buildCapsule } = require('../utils/message-capsule');
const crypto = require('crypto');

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
    try {
        fn();
        console.log(`  ✅  ${label}`);
        passed++;
    } catch (e) {
        console.log(`  ❌  ${label}`);
        console.log(`      ${e.message}`);
        failed++;
        failures.push({ label, error: e.message });
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

function assertNotEqual(a, b, msg) {
    if (a === b) throw new Error(msg || `expected values to differ, both were ${JSON.stringify(a)}`);
}

// Base capsule args
const BASE = {
    bookFractalId: 'book-test-001',
    tenantId: 1,
    phone: '+60123456789',
    body: 'Hello, this is a test message.',
    media: null,
    timestamp: '2026-03-25T00:00:00.000Z',
};

// ----------------------------------------------------------------
// SECTION 1: Required fields
// ----------------------------------------------------------------
console.log('\n📦 Required fields');

test('capsule has field: v', () => {
    const c = buildCapsule(BASE);
    assert('v' in c, 'missing field: v');
});

test('capsule.v === 1 (current schema version)', () => {
    const c = buildCapsule(BASE);
    assertEqual(c.v, 1, `expected v=1, got v=${c.v}`);
});

test('capsule has field: body', () => {
    const c = buildCapsule(BASE);
    assert('body' in c, 'missing field: body');
});

test('capsule has field: content_hash', () => {
    const c = buildCapsule(BASE);
    assert('content_hash' in c, 'missing field: content_hash');
});

test('capsule has field: sender_hash', () => {
    const c = buildCapsule(BASE);
    assert('sender_hash' in c, 'missing field: sender_hash');
});

test('capsule has field: timestamp', () => {
    const c = buildCapsule(BASE);
    assert('timestamp' in c, 'missing field: timestamp');
});

test('capsule has field: message_fractal_id', () => {
    const c = buildCapsule(BASE);
    assert('message_fractal_id' in c, 'missing field: message_fractal_id');
});

test('capsule has field: book_fractal_id', () => {
    const c = buildCapsule(BASE);
    assert('book_fractal_id' in c, 'missing field: book_fractal_id');
});

test('capsule has field: attachments (array)', () => {
    const c = buildCapsule(BASE);
    assert(Array.isArray(c.attachments), 'attachments should be an array');
});

// ----------------------------------------------------------------
// SECTION 2: content_hash (SHA256 of body)
// ----------------------------------------------------------------
console.log('\n🔐 content_hash (SHA256)');

test('content_hash is a 64-char hex string', () => {
    const c = buildCapsule(BASE);
    assert(/^[a-f0-9]{64}$/.test(c.content_hash), `invalid hash format: ${c.content_hash}`);
});

test('content_hash matches sha256(body)', () => {
    const c = buildCapsule(BASE);
    const expected = crypto.createHash('sha256').update(BASE.body).digest('hex');
    assertEqual(c.content_hash, expected, 'content_hash does not match sha256(body)');
});

test('content_hash is deterministic — same body → same hash', () => {
    const c1 = buildCapsule(BASE);
    const c2 = buildCapsule({ ...BASE, timestamp: '2026-04-01T00:00:00.000Z' }); // different ts, same body
    assertEqual(c1.content_hash, c2.content_hash, 'content_hash should not depend on timestamp');
});

test('content_hash is sensitive — different body → different hash', () => {
    const c1 = buildCapsule(BASE);
    const c2 = buildCapsule({ ...BASE, body: 'A completely different message.' });
    assertNotEqual(c1.content_hash, c2.content_hash, 'different bodies produced the same hash');
});

test('empty body → deterministic content_hash (not crash)', () => {
    const c = buildCapsule({ ...BASE, body: '' });
    const expected = crypto.createHash('sha256').update('').digest('hex');
    assertEqual(c.content_hash, expected, 'empty body hash mismatch');
});

// ----------------------------------------------------------------
// SECTION 3: sender_hash (HMAC-SHA256 of phone)
// ----------------------------------------------------------------
console.log('\n🔑 sender_hash (HMAC-SHA256)');

test('sender_hash is a 64-char hex string', () => {
    const c = buildCapsule(BASE);
    assert(/^[a-f0-9]{64}$/.test(c.sender_hash), `invalid hash format: ${c.sender_hash}`);
});

test('sender_hash is deterministic — same phone → same hash', () => {
    const c1 = buildCapsule(BASE);
    const c2 = buildCapsule({ ...BASE, body: 'Different body', timestamp: '2026-04-01T00:00:00.000Z' });
    assertEqual(c1.sender_hash, c2.sender_hash, 'same phone should produce same sender_hash');
});

test('sender_hash is sensitive — different phone → different hash', () => {
    const c1 = buildCapsule(BASE);
    const c2 = buildCapsule({ ...BASE, phone: '+60199999999' });
    assertNotEqual(c1.sender_hash, c2.sender_hash, 'different phones produced the same sender_hash');
});

test('sender_hash does NOT reveal raw phone — hash is one-way', () => {
    const c = buildCapsule(BASE);
    assert(!c.sender_hash.includes(BASE.phone.replace('+', '')), 'sender_hash should not contain raw phone digits');
    assert(c.body !== BASE.phone, 'body should not be the phone number');
});

test('null phone → deterministic sender_hash (not crash)', () => {
    const c1 = buildCapsule({ ...BASE, phone: null });
    const c2 = buildCapsule({ ...BASE, phone: null, body: 'other' });
    assertEqual(c1.sender_hash, c2.sender_hash, 'null phone should produce consistent hash');
});

// ----------------------------------------------------------------
// SECTION 4: Attachment hashing
// ----------------------------------------------------------------
console.log('\n📎 Attachment hashing');

test('no media → attachments is empty array', () => {
    const c = buildCapsule(BASE);
    assertEqual(c.attachments.length, 0, 'expected 0 attachments');
});

test('media present → attachments has one entry with hash', () => {
    const buf = Buffer.from('fake-image-data');
    const c = buildCapsule({ ...BASE, media: { buffer: buf, contentType: 'image/jpeg' } });
    assertEqual(c.attachments.length, 1, 'expected 1 attachment');
    assert(/^[a-f0-9]{64}$/.test(c.attachments[0].hash), 'attachment hash invalid format');
});

test('attachment hash matches sha256(buffer)', () => {
    const buf = Buffer.from('fake-image-data');
    const c = buildCapsule({ ...BASE, media: { buffer: buf, contentType: 'image/jpeg' } });
    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    assertEqual(c.attachments[0].hash, expected, 'attachment hash mismatch');
});

test('different buffer → different attachment hash', () => {
    const buf1 = Buffer.from('image-data-A');
    const buf2 = Buffer.from('image-data-B');
    const c1 = buildCapsule({ ...BASE, media: { buffer: buf1, contentType: 'image/jpeg' } });
    const c2 = buildCapsule({ ...BASE, media: { buffer: buf2, contentType: 'image/jpeg' } });
    assertNotEqual(c1.attachments[0].hash, c2.attachments[0].hash, 'different buffers should produce different hashes');
});

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ❌ ${f.label}: ${f.error}`));
}
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
