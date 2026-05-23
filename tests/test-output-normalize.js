#!/usr/bin/env node
/**
 * Tests for lib/normalize-output-credentials — boot-time legacy-shape rewrite.
 *
 * Uses an in-memory fake pg pool. No DB or HTTP required.
 *
 * Run: node tests/test-output-normalize.js
 */
'use strict';

const { normalizeOutputCredentials } = require('../lib/normalize-output-credentials');

let passed = 0, failed = 0;
function test(label, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { console.log(`  \u2705  ${label}`); passed++; })
        .catch(e => { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb) throw new Error(msg || `expected ${ja} === ${jb}`);
}

// In-memory fake pool. Each tenant is a Map<bookId, {output_credentials, output_01_url}>.
function makeFakePool(tenants) {
    return {
        async query(sql, params) {
            if (/FROM core\.tenant_catalog/.test(sql)) {
                return { rows: Object.keys(tenants).map(s => ({ tenant_schema: s })) };
            }
            const selMatch = sql.match(/FROM (\w+)\.books\s+WHERE output_credentials \? 'thread_id'\s+AND NOT \(output_credentials \? 'output_01'\)/);
            if (selMatch) {
                const schema = selMatch[1];
                const books = tenants[schema] || new Map();
                const rows = [];
                for (const [id, b] of books) {
                    const hasFlat = b.output_credentials && 'thread_id' in b.output_credentials;
                    const hasNested = b.output_credentials && 'output_01' in b.output_credentials;
                    if (hasFlat && !hasNested) {
                        rows.push({ id, output_credentials: b.output_credentials, output_01_url: b.output_01_url });
                    }
                }
                return { rows };
            }
            const updMatch = sql.match(/UPDATE (\w+)\.books SET output_credentials = \$1::jsonb WHERE id = \$2/);
            if (updMatch) {
                const schema = updMatch[1];
                const [credsJson, id] = params;
                const book = tenants[schema].get(id);
                book.output_credentials = JSON.parse(credsJson);
                return { rowCount: 1 };
            }
            throw new Error('fake pool: unhandled SQL: ' + sql);
        }
    };
}

(async () => {
    console.log('\n\uD83D\uDD27  normalizeOutputCredentials — legacy flat → nested rewrite');

    await test('legacy flat book gets rewritten to nested output_01', async () => {
        const tenants = {
            tenant_1: new Map([
                [101, {
                    output_credentials: { thread_id: 'T1', thread_name: 'Old Ledger', extra: 'preserved' },
                    output_01_url: 'https://hook.example/aaa/bbb'
                }]
            ])
        };
        const pool = makeFakePool(tenants);
        const result = await normalizeOutputCredentials(pool);
        assertEqual(result.rewritten, 1);
        const book = tenants.tenant_1.get(101);
        assertEqual(book.output_credentials.output_01, {
            type: 'thread',
            webhook_url: 'https://hook.example/aaa/bbb',
            thread_id: 'T1',
            thread_name: 'Old Ledger',
            channel_id: null
        });
        assertEqual(book.output_credentials.extra, 'preserved');
    });

    await test('nested-only book is left untouched', async () => {
        const orig = {
            output_credentials: { output_01: { type: 'thread', thread_id: 'TZ', webhook_url: 'https://w' } },
            output_01_url: 'https://w'
        };
        const tenants = { tenant_2: new Map([[202, JSON.parse(JSON.stringify(orig))]]) };
        const pool = makeFakePool(tenants);
        const result = await normalizeOutputCredentials(pool);
        assertEqual(result.rewritten, 0);
        assertEqual(tenants.tenant_2.get(202).output_credentials, orig.output_credentials);
    });

    await test('idempotent — second run on same data rewrites 0 rows', async () => {
        const tenants = {
            tenant_3: new Map([
                [303, {
                    output_credentials: { thread_id: 'T3' },
                    output_01_url: 'https://w'
                }]
            ])
        };
        const pool = makeFakePool(tenants);
        const r1 = await normalizeOutputCredentials(pool);
        assertEqual(r1.rewritten, 1);
        const r2 = await normalizeOutputCredentials(pool);
        assertEqual(r2.rewritten, 0, 'second run must not rewrite the already-nested book');
    });

    await test('mixed tenants — counts only legacy rows', async () => {
        const tenants = {
            tenant_a: new Map([
                [1, { output_credentials: { thread_id: 'T' }, output_01_url: 'https://w' }],
                [2, { output_credentials: { output_01: { thread_id: 'T2', type: 'thread' } }, output_01_url: 'https://w' }]
            ]),
            tenant_b: new Map([
                [3, { output_credentials: { thread_id: 'T3' }, output_01_url: 'https://w' }]
            ])
        };
        const pool = makeFakePool(tenants);
        const r = await normalizeOutputCredentials(pool);
        assertEqual(r.rewritten, 2);
        assert(tenants.tenant_a.get(1).output_credentials.output_01);
        assert(tenants.tenant_b.get(3).output_credentials.output_01);
    });

    console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
