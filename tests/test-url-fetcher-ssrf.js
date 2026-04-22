#!/usr/bin/env node
/**
 * SSRF redirect guard tests for lib/url-fetcher.js
 *
 * Verifies that 301/302 redirects pointing to private IPs are blocked
 * even when the initial URL passes the pre-fetch SSRF check.
 *
 * Run: node tests/test-url-fetcher-ssrf.js
 */
'use strict';

const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const { fetchUrl } = require('../lib/url-fetcher');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'assertion failed');
}

async function run(label, fn) {
    try {
        await fn();
        console.log(`  PASS  ${label}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${label}`);
        console.error(`        ${err.message}`);
        failures.push({ label, err });
        failed++;
    }
}

// Spin up an HTTP server that redirects all requests to `targetUrl`.
function makeRedirectServer(targetUrl) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(302, { Location: targetUrl });
            res.end();
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
        server.on('error', reject);
    });
}

// Monkey-patch net.isIP and dns.lookup so that 127.0.0.1 passes the initial
// SSRF pre-check (looks like a public host).  Redirect targets are checked
// separately — their IP literals hit isPrivateIp() directly without DNS.
function patchForLocalhost() {
    const origIsIP = net.isIP.bind(net);
    const origLookup = dns.lookup.bind(dns);

    net.isIP = (addr) => (addr === '127.0.0.1' ? 0 : origIsIP(addr));
    dns.lookup = async (hostname, ...args) => {
        if (hostname === '127.0.0.1') return { address: '93.184.216.34', family: 4 };
        return origLookup(hostname, ...args);
    };

    return () => {
        net.isIP = origIsIP;
        dns.lookup = origLookup;
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
    console.log('\nSSRF redirect guard — unit tests\n');

    await run('redirect to 169.254.169.254 (AWS metadata) is blocked', async () => {
        const { server, port } = await makeRedirectServer('http://169.254.169.254/latest/meta-data/');
        const restore = patchForLocalhost();
        let threw = false;
        let errMsg = '';
        try {
            await fetchUrl(`http://127.0.0.1:${port}/`);
        } catch (err) {
            threw = true;
            errMsg = err.message;
        } finally {
            restore();
            server.close();
        }
        assert(threw, 'Expected fetchUrl to throw on redirect to 169.254.169.254');
        assert(errMsg.includes('private') || errMsg.includes('reserved'), `Unexpected error: ${errMsg}`);
    });

    await run('redirect to 10.0.0.1 (RFC-1918) is blocked', async () => {
        const { server, port } = await makeRedirectServer('http://10.0.0.1/');
        const restore = patchForLocalhost();
        let threw = false;
        let errMsg = '';
        try {
            await fetchUrl(`http://127.0.0.1:${port}/`);
        } catch (err) {
            threw = true;
            errMsg = err.message;
        } finally {
            restore();
            server.close();
        }
        assert(threw, 'Expected fetchUrl to throw on redirect to 10.0.0.1');
        assert(errMsg.includes('private') || errMsg.includes('reserved'), `Unexpected error: ${errMsg}`);
    });

    await run('redirect to 192.168.1.1 (RFC-1918) is blocked', async () => {
        const { server, port } = await makeRedirectServer('http://192.168.1.1/');
        const restore = patchForLocalhost();
        let threw = false;
        let errMsg = '';
        try {
            await fetchUrl(`http://127.0.0.1:${port}/`);
        } catch (err) {
            threw = true;
            errMsg = err.message;
        } finally {
            restore();
            server.close();
        }
        assert(threw, 'Expected fetchUrl to throw on redirect to 192.168.1.1');
        assert(errMsg.includes('private') || errMsg.includes('reserved'), `Unexpected error: ${errMsg}`);
    });

    await run('redirect chain exceeding MAX_REDIRECTS (5) throws', async () => {
        // Build 7 servers each redirecting to the next — one more than the limit.
        const servers = [];
        const ports = [];

        for (let i = 0; i < 7; i++) {
            const { server, port } = await new Promise((resolve, reject) => {
                const s = http.createServer((_req, res) => {
                    const next = ports[i + 1];
                    res.writeHead(302, { Location: next ? `http://127.0.0.1:${next}/` : 'http://127.0.0.1:9/' });
                    res.end();
                });
                s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
                s.on('error', reject);
            });
            servers.push(server);
            ports.push(port);
        }

        const restore = patchForLocalhost();
        let threw = false;
        let errMsg = '';
        try {
            await fetchUrl(`http://127.0.0.1:${ports[0]}/`);
        } catch (err) {
            threw = true;
            errMsg = err.message;
        } finally {
            restore();
            for (const s of servers) s.close();
        }

        assert(threw, 'Expected fetchUrl to throw on redirect chain > MAX_REDIRECTS');
        assert(
            errMsg.toLowerCase().includes('redirect') || errMsg.includes('private') || errMsg.includes('reserved'),
            `Unexpected error: ${errMsg}`
        );
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failures.length) {
        for (const { label, err } of failures) {
            console.error(`FAIL: ${label}\n  ${err.stack || err.message}\n`);
        }
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
