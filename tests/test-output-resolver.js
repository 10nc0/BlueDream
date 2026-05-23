#!/usr/bin/env node
/**
 * Tests for lib/output-resolver — single source of truth for Discord output addressing.
 *
 * Run: node tests/test-output-resolver.js
 */
'use strict';

const { resolveOutput } = require('../lib/output-resolver');

let passed = 0, failed = 0;
function test(label, fn) {
    try { fn(); console.log(`  \u2705  ${label}`); passed++; }
    catch (e) { console.log(`  \u274C  ${label}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

console.log('\n\uD83E\uDDF5  Output resolver — canonical nested shape');
test('nested output_01 returns full envelope', () => {
    const book = {
        output_credentials: {
            output_01: {
                type: 'thread',
                webhook_url: 'https://discord.com/api/webhooks/X/Y',
                thread_id: 'T1',
                thread_name: 'Ledger',
                channel_id: 'C1'
            }
        }
    };
    const r = resolveOutput(book, 'output_01');
    assertEqual(r.type, 'thread');
    assertEqual(r.thread_id, 'T1');
    assertEqual(r.thread_name, 'Ledger');
    assertEqual(r.channel_id, 'C1');
    assertEqual(r.webhook_url, 'https://discord.com/api/webhooks/X/Y');
});

test('nested output_01 missing webhook_url falls back to book.output_01_url', () => {
    const book = {
        output_01_url: 'https://fallback.example/webhook',
        output_credentials: { output_01: { type: 'thread', thread_id: 'T2' } }
    };
    const r = resolveOutput(book, 'output_01');
    assertEqual(r.webhook_url, 'https://fallback.example/webhook');
    assertEqual(r.thread_id, 'T2');
});

test('nested output_0n resolves independently of output_01', () => {
    const book = {
        output_credentials: {
            output_0n: { type: 'thread', thread_id: 'N1', channel_id: 'NC1', webhook_url: 'https://w' }
        }
    };
    const r = resolveOutput(book, 'output_0n');
    assertEqual(r.thread_id, 'N1');
    assertEqual(r.channel_id, 'NC1');
});

test('infers type=channel when only channel_id is set', () => {
    const book = {
        output_credentials: { output_01: { channel_id: 'C9', webhook_url: 'https://w' } }
    };
    const r = resolveOutput(book, 'output_01');
    assertEqual(r.type, 'channel');
    assertEqual(r.channel_id, 'C9');
    assertEqual(r.thread_id, null);
});

console.log('\n\uD83D\uDD04  Legacy flat fallback');
test('legacy flat thread_id is normalized to nested envelope (caller indistinguishable)', () => {
    const nestedBook = {
        output_credentials: {
            output_01: { type: 'thread', thread_id: 'T_SAME', thread_name: 'L', webhook_url: 'https://w' }
        }
    };
    const flatBook = {
        output_01_url: 'https://w',
        output_credentials: { thread_id: 'T_SAME', thread_name: 'L' }
    };
    const a = resolveOutput(nestedBook, 'output_01');
    const b = resolveOutput(flatBook, 'output_01');
    assertEqual(a.type, b.type);
    assertEqual(a.thread_id, b.thread_id);
    assertEqual(a.thread_name, b.thread_name);
    assertEqual(a.webhook_url, b.webhook_url);
});

test('legacy flat is output_01-only (no flat fallback for output_0n)', () => {
    const book = { output_credentials: { thread_id: 'T_legacy' }, output_0n_url: 'https://w' };
    assert(resolveOutput(book, 'output_0n') === null, 'flat must not synthesize an output_0n');
});

console.log('\n\uD83D\uDEAB  Missing / malformed slots');
test('missing output_credentials returns null', () => {
    assert(resolveOutput({}, 'output_01') === null);
    assert(resolveOutput({ output_credentials: null }, 'output_01') === null);
});
test('unknown slot name returns null', () => {
    const book = { output_credentials: { output_01: { thread_id: 'T' } } };
    assert(resolveOutput(book, 'output_xx') === null);
});
test('null book returns null', () => {
    assert(resolveOutput(null, 'output_01') === null);
});
test('stringified output_credentials JSON is parsed', () => {
    const book = { output_credentials: JSON.stringify({ output_01: { thread_id: 'T_str', type: 'thread' } }) };
    const r = resolveOutput(book, 'output_01');
    assertEqual(r.thread_id, 'T_str');
});

console.log('\n\uD83D\uDD17  Webhook URL builder receives thread_id (regression for the limbo-channel bug)');
test('packet-queue → discord-webhooks envelope flow sets thread_id on URL', () => {
    // Simulate the exact flow packet-queue:347 now uses.
    const book = {
        output_01_url: 'https://discord.com/api/webhooks/AAA/BBB',
        output_credentials: { output_01: { type: 'thread', thread_id: 'TXYZ', webhook_url: 'https://discord.com/api/webhooks/AAA/BBB' } }
    };
    const options = { isMedia: false, output: resolveOutput(book, 'output_01') };
    assert(options.output, 'envelope must not be null');
    assertEqual(options.output.thread_id, 'TXYZ');

    // Replicate the URL-building branch in discord-webhooks.sendToLedger.
    const url = new URL(book.output_01_url);
    url.searchParams.set('wait', 'true');
    if (options.output?.type === 'thread' && options.output?.thread_id) {
        url.searchParams.set('thread_id', options.output.thread_id);
    }
    assertEqual(url.searchParams.get('thread_id'), 'TXYZ', 'thread_id MUST be on the URL — otherwise Discord drops to parent channel');
});

console.log(`\n\u2728 Total: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
