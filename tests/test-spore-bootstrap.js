#!/usr/bin/env node
/**
 * Tests for Task #219: Spore Protocol — POST /api/agent/bootstrap
 *
 * Pure / mock-based — no DB or HTTP server required.
 * Tests:
 *   1) validateBootstrapEntries — schema validation (too many tokens, bad since, etc.)
 *   2) runBootstrap with mock pool — token resolution (valid + invalid mix)
 *   3) limit / since cursor behaviour via in-memory stubs
 *   4) at-least-one-valid-token enforcement
 *   5) response ordering matches request array position
 *   6) tags + stats + messages shape in response
 *
 * Run: node tests/test-spore-bootstrap.js
 */

'use strict';

const crypto = require('crypto');
const {
    validateBootstrapEntries,
    runBootstrap,
    MAX_BOOKS,
    DEFAULT_LIMIT,
    MAX_LIMIT
} = require('../lib/spore-bootstrap');

let passed = 0, failed = 0;

function test(label, fn) {
    try { fn(); console.log(`  \u2705  ${label}`); passed++; }
    catch (e) { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

function hashToken(t) {
    return crypto.createHash('sha256').update(t).digest('hex');
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TOKEN_A = 'token-alpha-aabbccddeeff';
const TOKEN_B = 'token-beta-112233445566';

const FRACTAL_A = 'book_t1_aabbcc';
const FRACTAL_B = 'book_t2_112233';

const REGISTRY = [
    { agent_token_hash: hashToken(TOKEN_A), fractal_id: FRACTAL_A, tenant_schema: 'tenant_1', book_name: 'Alpha Book' },
    { agent_token_hash: hashToken(TOKEN_B), fractal_id: FRACTAL_B, tenant_schema: 'tenant_2', book_name: 'Beta Book'  }
];

/**
 * Build a minimal mock pool.
 * queryHandler(sql, params) → { rows }
 */
function makeMockPool(queryHandler) {
    return {
        query: (sql, params) => Promise.resolve(queryHandler(sql, params))
    };
}

/**
 * Default mock pool that serves all three query types for a given set of books.
 * bookData map: fractal_id → { tags, message_count, last_message_at, messages[] }
 */
function makeDefaultPool(bookData) {
    bookData = bookData || {};
    return makeMockPool(function(sql, params) {
        // Batch registry lookup
        if (sql.includes('core.book_registry') && sql.includes('ANY')) {
            const hashes = params[0];
            const rows = REGISTRY.filter(function(r) { return hashes.includes(r.agent_token_hash); });
            return { rows: rows };
        }

        const fractalId = params[0];
        const data = bookData[fractalId] || {};

        // Books table (title + tags)
        if (sql.includes('.books') && sql.includes('tags')) {
            return { rows: [{ name: data.title || 'Untitled', tags: data.tags || [] }] };
        }

        // Stats (COUNT + MAX)
        if (sql.includes('COUNT(*)') && sql.includes('last_message_at')) {
            return {
                rows: [{
                    message_count: data.message_count || 0,
                    last_message_at: data.last_message_at || null
                }]
            };
        }

        // Messages list
        if (sql.includes('sender_name') && sql.includes('has_attachment')) {
            const msgs = (data.messages || []).slice(0, params[1]);
            return { rows: msgs };
        }

        return { rows: [] };
    });
}

async function main() {

    // ── 1. validateBootstrapEntries ───────────────────────────────────────────

    console.log('\n\uD83D\uDD0D validateBootstrapEntries — schema validation');

    test('null / non-array → error', function() {
        const r = validateBootstrapEntries(null);
        assert(!r.ok);
        assertEqual(r.status, 400);
        assert(r.error.includes('non-empty array'));
    });

    test('empty array → error', function() {
        const r = validateBootstrapEntries([]);
        assert(!r.ok);
        assertEqual(r.status, 400);
    });

    test('more than MAX_BOOKS entries → error', function() {
        const many = Array.from({ length: MAX_BOOKS + 1 }, function(_, i) { return { token: 't' + i }; });
        const r = validateBootstrapEntries(many);
        assert(!r.ok);
        assertEqual(r.status, 400);
        assert(r.error.toLowerCase().includes('too many'), 'expected "too many" in: ' + r.error);
    });

    test('entry missing token → error identifies index', function() {
        const r = validateBootstrapEntries([{ token: 'ok' }, { limit: 10 }]);
        assert(!r.ok);
        assert(r.error.includes('[1]'), 'expected [1] in: ' + r.error);
    });

    test('empty-string token → error', function() {
        const r = validateBootstrapEntries([{ token: '   ' }]);
        assert(!r.ok);
        assert(r.error.includes('[0]'), 'expected [0] in: ' + r.error);
    });

    test('limit 0 → error', function() {
        const r = validateBootstrapEntries([{ token: 't', limit: 0 }]);
        assert(!r.ok);
        assert(r.error.includes('[0].limit'), 'expected [0].limit in: ' + r.error);
    });

    test('limit MAX_LIMIT+1 → error', function() {
        const r = validateBootstrapEntries([{ token: 't', limit: MAX_LIMIT + 1 }]);
        assert(!r.ok);
        assert(r.error.includes('[0].limit'), 'expected [0].limit in: ' + r.error);
    });

    test('since: invalid string → error', function() {
        const r = validateBootstrapEntries([{ token: 't', since: '2026-01-01' }]);
        assert(!r.ok);
        assert(r.error.includes('[0].since'), 'expected [0].since in: ' + r.error);
    });

    test('since: not a string → error', function() {
        const r = validateBootstrapEntries([{ token: 't', since: 12345 }]);
        assert(!r.ok);
        assert(r.error.includes('[0].since'), 'expected [0].since in: ' + r.error);
    });

    test('valid entry with defaults → normalised correctly', function() {
        const r = validateBootstrapEntries([{ token: '  my-token  ' }]);
        assert(r.ok, 'expected ok, got: ' + r.error);
        assertEqual(r.entries.length, 1);
        assertEqual(r.entries[0].token, 'my-token');
        assertEqual(r.entries[0].limit, DEFAULT_LIMIT);
        assertEqual(r.entries[0].since, null);
        assertEqual(r.entries[0].tokenIndex, 0);
    });

    test('valid entry with explicit limit and since', function() {
        const r = validateBootstrapEntries([{ token: 't', limit: 10, since: '2026-01-01T00:00:00.000Z' }]);
        assert(r.ok, 'expected ok');
        assertEqual(r.entries[0].limit, 10);
        assertEqual(r.entries[0].since, '2026-01-01T00:00:00.000Z');
    });

    test('multiple valid entries → all normalised, tokenIndex preserved', function() {
        const r = validateBootstrapEntries([
            { token: 'tok-0' },
            { token: 'tok-1', limit: 100 }
        ]);
        assert(r.ok);
        assertEqual(r.entries[0].tokenIndex, 0);
        assertEqual(r.entries[1].tokenIndex, 1);
        assertEqual(r.entries[1].limit, 100);
    });

    test('MAX_LIMIT boundary — limit=200 accepted, limit=201 rejected', function() {
        const ok = validateBootstrapEntries([{ token: 't', limit: MAX_LIMIT }]);
        assert(ok.ok, 'limit ' + MAX_LIMIT + ' should be accepted');
        const bad = validateBootstrapEntries([{ token: 't', limit: MAX_LIMIT + 1 }]);
        assert(!bad.ok, 'limit ' + (MAX_LIMIT + 1) + ' should be rejected');
    });

    // ── 2. runBootstrap — token resolution ────────────────────────────────────

    console.log('\n\uD83D\uDD11 runBootstrap — token resolution (valid + invalid mix)');

    await (async function() {
        const pool = makeDefaultPool({});
        const r = await runBootstrap([{ token: 'bogus-token-xyz' }], pool);
        try {
            assert(!r.ok);
            assertEqual(r.status, 401);
            assert(r.error.includes('No valid tokens'), 'expected "No valid tokens" in: ' + r.error);
            console.log('  \u2705  all invalid tokens → 401 with no-valid-token message');
            passed++;
        } catch (e) {
            console.log('  \u274C  all invalid tokens → 401 with no-valid-token message\n      ' + e.message);
            failed++;
        }
    })();

    await (async function() {
        const msgTs = '2026-03-15T10:00:00.000Z';
        const pool = makeDefaultPool({
            [FRACTAL_A]: {
                title: 'Alpha Book',
                tags:  ['vehicle', 'repair'],
                message_count: 42,
                last_message_at: new Date(msgTs),
                messages: [
                    { id: 'msg-1', body: 'test message', sender_name: 'Alice', has_attachment: false, media_url: null, sent_at: new Date(msgTs) }
                ]
            }
        });
        const r = await runBootstrap([{ token: TOKEN_A }], pool);
        try {
            assert(r.ok, 'expected ok; got: ' + JSON.stringify(r));
            assertEqual(r.books.length, 1);
            const book = r.books[0];
            assertEqual(book.token_index, 0);
            assertEqual(book.fractal_id, FRACTAL_A);
            assertEqual(book.title, 'Alpha Book');
            assert(Array.isArray(book.tags), 'tags must be array');
            assert(book.tags.includes('vehicle'), 'tags must include vehicle');
            assertEqual(book.stats.message_count, 42);
            assert(book.stats.last_message_at, 'last_message_at should be present');
            assertEqual(book.messages.length, 1);
            assertEqual(book.messages[0].sender, 'Alice');
            assertEqual(book.messages[0].has_attachment, false);
            assert(r.bootstrap_at, 'bootstrap_at should be set');
            assertEqual(r.total_books, 1);
            console.log('  \u2705  single valid token → full book slot shape');
            passed++;
        } catch (e) {
            console.log('  \u274C  single valid token → full book slot shape\n      ' + e.message);
            failed++;
        }
    })();

    await (async function() {
        const pool = makeDefaultPool({
            [FRACTAL_B]: {
                title: 'Beta Book',
                tags:  [],
                message_count: 7,
                last_message_at: null,
                messages: []
            }
        });
        const r = await runBootstrap([
            { token: 'definitely-invalid-token-000' },
            { token: TOKEN_B }
        ], pool);
        try {
            assert(r.ok, 'expected ok');
            assertEqual(r.books.length, 2);
            const slot0 = r.books[0];
            assertEqual(slot0.token_index, 0);
            assertEqual(slot0.error, 'invalid_token');
            assert(!slot0.fractal_id, 'invalid slot must not have fractal_id');
            const slot1 = r.books[1];
            assertEqual(slot1.token_index, 1);
            assertEqual(slot1.fractal_id, FRACTAL_B);
            assert(!slot1.error, 'valid slot must not have error');
            assertEqual(r.total_books, 1, 'total_books counts only successful slots');
            console.log('  \u2705  valid + invalid mix — invalid slot does not fail others');
            passed++;
        } catch (e) {
            console.log('  \u274C  valid + invalid mix — invalid slot does not fail others\n      ' + e.message);
            failed++;
        }
    })();

    await (async function() {
        const pool = makeDefaultPool({
            [FRACTAL_A]: { title: 'A', tags: [], message_count: 1, last_message_at: null, messages: [] },
            [FRACTAL_B]: { title: 'B', tags: [], message_count: 2, last_message_at: null, messages: [] }
        });
        const r = await runBootstrap([{ token: TOKEN_B }, { token: TOKEN_A }], pool);
        try {
            assert(r.ok);
            assertEqual(r.books[0].token_index, 0);
            assertEqual(r.books[0].fractal_id, FRACTAL_B);
            assertEqual(r.books[1].token_index, 1);
            assertEqual(r.books[1].fractal_id, FRACTAL_A);
            console.log('  \u2705  response ordering follows request array position');
            passed++;
        } catch (e) {
            console.log('  \u274C  response ordering follows request array position\n      ' + e.message);
            failed++;
        }
    })();

    // ── 3. limit / since cursor behaviour ─────────────────────────────────────

    console.log('\n\uD83D\uDCC4 runBootstrap — limit + since cursor');

    await (async function() {
        const allMessages = Array.from({ length: 10 }, function(_, i) {
            return {
                id: 'msg-' + i, body: 'msg ' + i, sender_name: 'Bot',
                has_attachment: false, media_url: null,
                sent_at: new Date('2026-03-' + String(i + 1).padStart(2, '0') + 'T00:00:00.000Z')
            };
        });
        const pool = makeDefaultPool({
            [FRACTAL_A]: {
                title: 'A', tags: [], message_count: 10, last_message_at: null,
                messages: allMessages
            }
        });
        const r = await runBootstrap([{ token: TOKEN_A, limit: 3 }], pool);
        try {
            assert(r.ok);
            assertEqual(r.books[0].messages.length, 3, 'expected 3 messages, got ' + r.books[0].messages.length);
            console.log('  \u2705  limit is respected — only N messages returned');
            passed++;
        } catch (e) {
            console.log('  \u274C  limit is respected — only N messages returned\n      ' + e.message);
            failed++;
        }
    })();

    await (async function() {
        let capturedSql = null;
        let capturedParams = null;
        const pool = makeMockPool(function(sql, params) {
            if (sql.includes('core.book_registry')) {
                return { rows: [REGISTRY[0]] };
            }
            if (sql.includes('.books') && sql.includes('tags')) {
                return { rows: [{ name: 'A', tags: [] }] };
            }
            if (sql.includes('COUNT(*)')) {
                return { rows: [{ message_count: 0, last_message_at: null }] };
            }
            if (sql.includes('sender_name')) {
                capturedSql    = sql;
                capturedParams = params;
                return { rows: [] };
            }
            return { rows: [] };
        });

        const since = '2026-01-15T12:00:00.000Z';
        await runBootstrap([{ token: TOKEN_A, since: since }], pool);

        try {
            assert(capturedSql, 'message query should have been executed');
            assert(capturedSql.includes('COALESCE(sent_at, recorded_at) >'), 'SQL should include since filter');
            assert(capturedParams.includes(since), 'since value should appear in params; got: ' + JSON.stringify(capturedParams));
            console.log('  \u2705  since cursor passed to SQL query correctly');
            passed++;
        } catch (e) {
            console.log('  \u274C  since cursor passed to SQL query correctly\n      ' + e.message);
            failed++;
        }
    })();

    await (async function() {
        let capturedLimit = null;
        const pool = makeMockPool(function(sql, params) {
            if (sql.includes('core.book_registry')) return { rows: [REGISTRY[0]] };
            if (sql.includes('.books') && sql.includes('tags')) return { rows: [{ name: 'A', tags: [] }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ message_count: 0, last_message_at: null }] };
            if (sql.includes('sender_name')) { capturedLimit = params[1]; return { rows: [] }; }
            return { rows: [] };
        });

        await runBootstrap([{ token: TOKEN_A }], pool);
        try {
            assertEqual(capturedLimit, DEFAULT_LIMIT, 'expected default limit ' + DEFAULT_LIMIT + ', got ' + capturedLimit);
            console.log('  \u2705  default limit ' + DEFAULT_LIMIT + ' applied when not specified');
            passed++;
        } catch (e) {
            console.log('  \u274C  default limit ' + DEFAULT_LIMIT + ' applied when not specified\n      ' + e.message);
            failed++;
        }
    })();

    // ── 4. Edge cases ─────────────────────────────────────────────────────────

    console.log('\n\uD83E\uDDEA Edge cases');

    await (async function() {
        const pool = makeDefaultPool({
            [FRACTAL_A]: { title: 'A', tags: [], message_count: 5, last_message_at: null, messages: [] }
        });
        const r = await runBootstrap([{ token: TOKEN_A }, { token: TOKEN_A }], pool);
        try {
            assert(r.ok);
            assertEqual(r.books.length, 2);
            assertEqual(r.books[0].fractal_id, FRACTAL_A);
            assertEqual(r.books[1].fractal_id, FRACTAL_A);
            assertEqual(r.books[0].token_index, 0);
            assertEqual(r.books[1].token_index, 1);
            console.log('  \u2705  duplicate tokens in same request — each slot resolved independently');
            passed++;
        } catch (e) {
            console.log('  \u274C  duplicate tokens in same request — each slot resolved independently\n      ' + e.message);
            failed++;
        }
    })();

    await (async function() {
        const pool = makeDefaultPool({
            [FRACTAL_A]: { title: 'A', tags: [], message_count: 0, last_message_at: null, messages: [] }
        });
        const r = await runBootstrap([{ token: TOKEN_A }], pool);
        try {
            assert(r.ok);
            assertEqual(r.books[0].stats.message_count, 0);
            assertEqual(r.books[0].stats.last_message_at, null);
            console.log('  \u2705  null last_message_at (empty book) propagated as null');
            passed++;
        } catch (e) {
            console.log('  \u274C  null last_message_at (empty book) propagated as null\n      ' + e.message);
            failed++;
        }
    })();

    await (async function() {
        const dateObj = new Date('2026-04-20T08:30:00.000Z');
        const pool = makeDefaultPool({
            [FRACTAL_A]: {
                title: 'A', tags: [], message_count: 1,
                last_message_at: dateObj,
                messages: [{ id: 'x', body: 'hi', sender_name: 'Bot', has_attachment: false, media_url: null, sent_at: dateObj }]
            }
        });
        const r = await runBootstrap([{ token: TOKEN_A }], pool);
        try {
            assert(r.ok);
            const msg = r.books[0].messages[0];
            assertEqual(typeof msg.sent_at, 'string', 'sent_at must be a string');
            assert(msg.sent_at.includes('2026-04-20'), 'expected ISO date with 2026-04-20, got ' + msg.sent_at);
            console.log('  \u2705  Date-object sent_at → ISO string in response');
            passed++;
        } catch (e) {
            console.log('  \u274C  Date-object sent_at → ISO string in response\n      ' + e.message);
            failed++;
        }
    })();

    console.log('\n\u2728 Total: ' + passed + ' passed, ' + failed + ' failed\n');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(err) {
    console.error('Unexpected error:', err);
    process.exit(1);
});
