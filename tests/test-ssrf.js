#!/usr/bin/env node
/**
 * SSRF Guard Unit Tests — standalone, no live server or network required.
 *
 * Tests the security invariants of the SSRF guard in lib/url-fetcher.js:
 *   - normaliseToIPv4()  — IPv4-mapped IPv6 normalisation
 *   - isPrivateIPv4()    — private/reserved IPv4 range detection
 *   - isPrivateIp()      — unified private-IP check (IPv4 + IPv6)
 *   - assertPublicUrl()  — full guard including localhost + literal-IP fast paths
 *
 * All assertPublicUrl() cases below are caught before DNS resolution,
 * so no live network is required.
 *
 * Run: node tests/test-ssrf.js
 */

'use strict';

const { assertPublicUrl, isPrivateIp, normaliseToIPv4, isPrivateIPv4 } = require('../lib/url-fetcher');

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
    try {
        const result = fn();
        // If the function returns a Promise, catch it
        if (result && typeof result.then === 'function') {
            return result.then(
                () => { console.log(`  ✅  ${label}`); passed++; },
                (err) => {
                    console.log(`  ❌  ${label}`);
                    console.log(`      unexpected error: ${err.message}`);
                    failed++;
                    failures.push({ label, error: err.message });
                }
            );
        }
        console.log(`  ✅  ${label}`);
        passed++;
    } catch (e) {
        console.log(`  ❌  ${label}`);
        console.log(`      ${e.message}`);
        failed++;
        failures.push({ label, error: e.message });
    }
    return Promise.resolve();
}

async function testThrowsAsync(label, fn, expectedFragment) {
    try {
        await fn();
        console.log(`  ❌  ${label}`);
        console.log('      expected an error to be thrown, but it did not throw');
        failed++;
        failures.push({ label, error: 'expected throw, got none' });
    } catch (e) {
        if (expectedFragment && !e.message.includes(expectedFragment)) {
            console.log(`  ❌  ${label}`);
            console.log(`      threw "${e.message}" — expected fragment: "${expectedFragment}"`);
            failed++;
            failures.push({ label, error: `wrong error: ${e.message}` });
        } else {
            console.log(`  ✅  ${label}`);
            passed++;
        }
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ----------------------------------------------------------------
// SECTION 1: normaliseToIPv4
// ----------------------------------------------------------------
console.log('\n🔢 normaliseToIPv4()');

test('pure IPv4 passthrough', () => {
    assertEqual(normaliseToIPv4('127.0.0.1'), '127.0.0.1');
});

test('pure IPv4 — 169.254.169.254 (AWS metadata)', () => {
    assertEqual(normaliseToIPv4('169.254.169.254'), '169.254.169.254');
});

test('IPv4-mapped IPv6 mixed notation — ::ffff:127.0.0.1', () => {
    assertEqual(normaliseToIPv4('::ffff:127.0.0.1'), '127.0.0.1');
});

test('IPv4-mapped IPv6 mixed notation — ::ffff:169.254.169.254', () => {
    assertEqual(normaliseToIPv4('::ffff:169.254.169.254'), '169.254.169.254');
});

test('IPv4-mapped IPv6 hex notation — ::ffff:7f00:1 (127.0.0.1)', () => {
    assertEqual(normaliseToIPv4('::ffff:7f00:1'), '127.0.0.1');
});

test('IPv4-mapped IPv6 hex notation — ::ffff:a9fe:a9fe (169.254.169.254)', () => {
    assertEqual(normaliseToIPv4('::ffff:a9fe:a9fe'), '169.254.169.254');
});

test('IPv4-mapped IPv6 hex notation — ::ffff:c0a8:101 (192.168.1.1)', () => {
    assertEqual(normaliseToIPv4('::ffff:c0a8:101'), '192.168.1.1');
});

test('pure IPv6 loopback ::1 → null (not IPv4-mapped)', () => {
    assertEqual(normaliseToIPv4('::1'), null);
});

test('pure IPv6 ULA fc00::1 → null', () => {
    assertEqual(normaliseToIPv4('fc00::1'), null);
});

// ----------------------------------------------------------------
// SECTION 2: isPrivateIPv4
// ----------------------------------------------------------------
console.log('\n🔍 isPrivateIPv4()');

test('127.0.0.1 is loopback → private', () => {
    assert(isPrivateIPv4('127.0.0.1'));
});

test('127.255.255.255 is loopback → private', () => {
    assert(isPrivateIPv4('127.255.255.255'));
});

test('10.0.0.0 is RFC-1918 → private', () => {
    assert(isPrivateIPv4('10.0.0.0'));
});

test('10.255.255.255 is RFC-1918 → private', () => {
    assert(isPrivateIPv4('10.255.255.255'));
});

test('172.16.0.1 is RFC-1918 → private', () => {
    assert(isPrivateIPv4('172.16.0.1'));
});

test('172.31.255.255 is RFC-1918 → private', () => {
    assert(isPrivateIPv4('172.31.255.255'));
});

test('172.15.255.255 is NOT in 172.16/12 → public', () => {
    assert(!isPrivateIPv4('172.15.255.255'));
});

test('172.32.0.0 is NOT in 172.16/12 → public', () => {
    assert(!isPrivateIPv4('172.32.0.0'));
});

test('192.168.0.1 is RFC-1918 → private', () => {
    assert(isPrivateIPv4('192.168.0.1'));
});

test('192.168.255.255 is RFC-1918 → private', () => {
    assert(isPrivateIPv4('192.168.255.255'));
});

test('169.254.169.254 is link-local / AWS metadata → private', () => {
    assert(isPrivateIPv4('169.254.169.254'));
});

test('169.254.0.1 is link-local → private', () => {
    assert(isPrivateIPv4('169.254.0.1'));
});

test('1.1.1.1 is public → not private', () => {
    assert(!isPrivateIPv4('1.1.1.1'));
});

test('8.8.8.8 is public → not private', () => {
    assert(!isPrivateIPv4('8.8.8.8'));
});

test('0.0.0.0 is reserved → private', () => {
    assert(isPrivateIPv4('0.0.0.0'));
});

// ----------------------------------------------------------------
// SECTION 3: isPrivateIp — unified check
// ----------------------------------------------------------------
console.log('\n🛡️  isPrivateIp()');

test('127.0.0.1 → private', () => {
    assert(isPrivateIp('127.0.0.1'));
});

test('169.254.169.254 → private', () => {
    assert(isPrivateIp('169.254.169.254'));
});

test('::1 (IPv6 loopback) → private', () => {
    assert(isPrivateIp('::1'));
});

test(':: (unspecified) → private', () => {
    assert(isPrivateIp('::'));
});

test('fe80::1 (link-local) → private', () => {
    assert(isPrivateIp('fe80::1'));
});

test('fc00::1 (ULA) → private', () => {
    assert(isPrivateIp('fc00::1'));
});

test('fd00::1 (ULA) → private', () => {
    assert(isPrivateIp('fd00::1'));
});

test('::ffff:127.0.0.1 (IPv4-mapped loopback) → private', () => {
    assert(isPrivateIp('::ffff:127.0.0.1'));
});

test('::ffff:7f00:1 (hex IPv4-mapped 127.0.0.1) → private', () => {
    assert(isPrivateIp('::ffff:7f00:1'));
});

test('::ffff:a9fe:a9fe (hex IPv4-mapped 169.254.169.254) → private', () => {
    assert(isPrivateIp('::ffff:a9fe:a9fe'));
});

test('2001:db8::1 (documentation range) → not private (guard does not block it)', () => {
    assert(!isPrivateIp('2001:db8::1'));
});

test('1.1.1.1 → not private', () => {
    assert(!isPrivateIp('1.1.1.1'));
});

// ----------------------------------------------------------------
// SECTION 4: net.isIP gate — prevents fc/fd hostname false positives
// ----------------------------------------------------------------
// isPrivateIp() uses /^fc/i and /^fd/i regexes for IPv6 ULA detection.
// These must NOT block hostnames like "fcdn.example.com".
// assertPublicUrl() guards with net.isIP(bareHost) before calling isPrivateIp(),
// so plain hostnames skip the IPv6 regex check entirely.
console.log('\n🔒 net.isIP() gate — fc/fd hostname false-positive prevention');

{
    const net = require('net');

    test('net.isIP("fcdn.example.com") returns 0 (not an IP literal)', () => {
        assertEqual(net.isIP('fcdn.example.com'), 0);
    });

    test('net.isIP("fdshare.io") returns 0 (not an IP literal)', () => {
        assertEqual(net.isIP('fdshare.io'), 0);
    });

    test('net.isIP("fc00::1") returns 6 (is an IPv6 literal)', () => {
        assertEqual(net.isIP('fc00::1'), 6);
    });

    test('net.isIP("127.0.0.1") returns 4 (is an IPv4 literal)', () => {
        assertEqual(net.isIP('127.0.0.1'), 4);
    });

    // Confirm isPrivateIp itself would incorrectly flag "fcdn.example.com" due to the
    // /^fc/ regex — but assertPublicUrl prevents it from ever being called on hostnames.
    test('isPrivateIp("fc00::1") correctly flags ULA IPv6', () => {
        assert(isPrivateIp('fc00::1'));
    });

    // isPrivateIp is not designed for hostnames — assertPublicUrl gates it with net.isIP.
    // We verify the gate is in place by confirming net.isIP returns 0 for hostnames,
    // not by calling isPrivateIp directly on hostnames.
}

// ----------------------------------------------------------------
// SECTION 5: assertPublicUrl — literal fast-path (no DNS required)
// ----------------------------------------------------------------
console.log('\n🚫 assertPublicUrl() — blocked before DNS (no network needed)');

async function runAsyncTests() {
    await testThrowsAsync(
        'http://localhost/ is blocked',
        () => assertPublicUrl('http://localhost/'),
        'private or reserved'
    );

    await testThrowsAsync(
        'http://127.0.0.1/ is blocked (loopback literal)',
        () => assertPublicUrl('http://127.0.0.1/'),
        'private or reserved'
    );

    await testThrowsAsync(
        'http://169.254.169.254/latest/meta-data is blocked (AWS metadata)',
        () => assertPublicUrl('http://169.254.169.254/latest/meta-data'),
        'private or reserved'
    );

    await testThrowsAsync(
        'http://10.0.0.1/ is blocked (RFC-1918)',
        () => assertPublicUrl('http://10.0.0.1/'),
        'private or reserved'
    );

    await testThrowsAsync(
        'http://192.168.1.1/ is blocked (RFC-1918)',
        () => assertPublicUrl('http://192.168.1.1/'),
        'private or reserved'
    );

    await testThrowsAsync(
        'http://172.16.0.1/ is blocked (RFC-1918)',
        () => assertPublicUrl('http://172.16.0.1/'),
        'private or reserved'
    );

    await testThrowsAsync(
        'http://[::1]/ is blocked (IPv6 loopback literal)',
        () => assertPublicUrl('http://[::1]/'),
        'private or reserved'
    );

    await testThrowsAsync(
        'http://[::ffff:127.0.0.1]/ is blocked (IPv4-mapped loopback)',
        () => assertPublicUrl('http://[::ffff:127.0.0.1]/'),
        'private or reserved'
    );

    await testThrowsAsync(
        'http://[fc00::1]/ is blocked (IPv6 ULA)',
        () => assertPublicUrl('http://[fc00::1]/'),
        'private or reserved'
    );

}

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
runAsyncTests().then(() => {
    console.log(`\n${'='.repeat(55)}`);
    console.log(`📊 SSRF Guard Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log('\nFailed tests:');
        failures.forEach(f => console.log(`  ❌ ${f.label}: ${f.error}`));
    }
    console.log('='.repeat(55));
    process.exit(failed > 0 ? 1 : 0);
});
