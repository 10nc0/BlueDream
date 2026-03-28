#!/usr/bin/env node
const http = require('http');

const PORT = process.env.PORT || 5000;
const HOST = 'localhost';

const TESTS = [
  { name: 'Health',                method: 'GET',  path: '/health',                    expect: 200 },
  { name: 'Health Deep',           method: 'GET',  path: '/health/deep',               expect: 200 },
  { name: 'Static: index.html',    method: 'GET',  path: '/index.html',                expect: 200 },
  { name: 'Static: playground',    method: 'GET',  path: '/playground.html',            expect: 200 },
  { name: 'Static: login',         method: 'GET',  path: '/login.html',                expect: 200 },
  { name: 'Static: manifest.json', method: 'GET',  path: '/manifest.json',             expect: 200 },
  { name: 'Static: sw.js',         method: 'GET',  path: '/sw.js',                     expect: 200 },
  { name: 'Auth status (no JWT)',   method: 'GET',  path: '/api/auth/status',           expect: 200 },
  { name: 'Auth check-genesis',    method: 'GET',  path: '/api/auth/check-genesis',    expect: 200 },
  { name: 'Books (no JWT)',         method: 'GET',  path: '/api/books',                 expect: 401 },
  { name: 'Books top (no JWT)',     method: 'GET',  path: '/api/books/top',             expect: 401 },
  { name: 'Playground usage',      method: 'GET',  path: '/api/playground/usage',      expect: 200 },
  { name: 'Drops (no JWT)',         method: 'GET',  path: '/api/drops/search/test',     expect: 401 },
  { name: 'Nyan-AI audit (no JWT)', method: 'POST', path: '/api/nyan-ai/audit',         expect: 401, body: '{}' },
  { name: 'Twilio webhook (empty)', method: 'POST', path: '/api/twilio/webhook',        expect: [200, 400, 401, 403], body: '' },
];

let passed = 0;
let failed = 0;
const failures = [];

function request(test) {
  return new Promise((resolve) => {
    const opts = {
      hostname: HOST,
      port: PORT,
      path: test.path,
      method: test.method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', (err) => resolve({ status: 0, data: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: 'timeout' }); });

    if (test.body !== undefined) req.write(test.body);
    req.end();
  });
}

async function run() {
  console.log(`\n  Smoke Tests — ${HOST}:${PORT}`);
  console.log('  ' + '─'.repeat(50));

  for (const test of TESTS) {
    const result = await request(test);
    const expects = Array.isArray(test.expect) ? test.expect : [test.expect];
    const ok = expects.includes(result.status);

    if (ok) {
      passed++;
      console.log(`  ✓  ${test.name} → ${result.status}`);
    } else {
      failed++;
      failures.push({ name: test.name, expected: test.expect, got: result.status });
      console.log(`  ✗  ${test.name} → ${result.status} (expected ${test.expect})`);
    }
  }

  console.log('  ' + '─'.repeat(50));
  console.log(`  ${passed} passed, ${failed} failed out of ${TESTS.length}\n`);

  if (failures.length > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: got ${f.got}, expected ${f.expected}`));
    console.log('');
    process.exit(1);
  }

  process.exit(0);
}

run();
