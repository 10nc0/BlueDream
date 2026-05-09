'use strict';

// Override-propagation tests — proves BRAND env overrides actually reach
// the runtime values used at the four headline callsites:
//   1. OpenRouter HTTP-Referer + X-Title headers (utils/groq-client.js)
//   2. IPFS pin metadata name prefix (utils/ipfs-pinner.js)
//   3. JWT issuer + audience claims (lib/auth-service.js)
//   4. User-visible email subject templates (routes/auth.js, routes/books/shares.js)
//
// These tests complement tests/test-brand-defaults.js, which only proves
// the BRAND module itself reads env. Here we prove the values actually
// propagate to outbound headers, signed tokens, and rendered templates.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { console.log(`  ✓ ${name}`); passed++; },
        e => { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
      );
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed++;
  }
}

const BRAND_KEYS = [
  'BRAND_NAME', 'BRAND_NAME_LOWER',
  'RESEND_FROM_EMAIL', 'RESEND_FROM_NAME',
  'BRAND_IPFS_PREFIX',
  'BRAND_JWT_ISSUER', 'BRAND_JWT_AUDIENCE',
  'BRAND_OPENROUTER_TITLE', 'BRAND_OPENROUTER_REFERER',
  'BRAND_DATA_SALT', 'BRAND_BACKUP_PREFIX',
  'BRAND_EXPORT_FORMAT_TAG', 'BRAND_EXPORT_SOURCE_FALLBACK',
];

function snapshotEnv(extraKeys = []) {
  const keys = [...BRAND_KEYS, ...extraKeys];
  const snap = {};
  for (const k of keys) snap[k] = process.env[k];
  return { keys, snap };
}

function restoreEnv({ keys, snap }) {
  for (const k of keys) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

function purgeCache(...modulePaths) {
  for (const m of modulePaths) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
}

console.log('\n=== Brand Overrides — callsite propagation ===\n');

(async () => {

  // --------------------------------------------------------------
  // 1. OpenRouter headers pick up BRAND.openrouterReferer + Title
  // --------------------------------------------------------------
  await test('OpenRouter request headers reflect BRAND_OPENROUTER_TITLE / _REFERER override', async () => {
    const env = snapshotEnv(['OPENROUTER_API_KEY', 'PLAYGROUND_AI_KEY', 'PLAYGROUND_GROQ_TOKEN']);
    try {
      // Wipe brand env, then set Acme overrides.
      for (const k of BRAND_KEYS) delete process.env[k];
      process.env.BRAND_OPENROUTER_TITLE = 'Acme';
      process.env.BRAND_OPENROUTER_REFERER = 'https://acme.example';
      process.env.OPENROUTER_API_KEY = 'fake-or-key-for-test';
      // Ensure no Groq token so cascade jumps straight to OpenRouter.
      delete process.env.PLAYGROUND_AI_KEY;
      delete process.env.PLAYGROUND_GROQ_TOKEN;

      // Stub axios.post on the cached singleton.
      const axios = require('axios');
      const origPost = axios.post;
      let capturedConfig = null;
      let capturedUrl = null;
      axios.post = async (url, data, config) => {
        capturedUrl = url;
        capturedConfig = config;
        return { data: { choices: [{ message: { content: 'ok' } }] } };
      };

      try {
        // Force fresh require chain so BRAND + groq-client re-bind.
        purgeCache('../config/brand', '../utils/groq-client');
        const { groqWithRetry } = require('../utils/groq-client');

        await groqWithRetry({
          data: { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] },
          config: { headers: { /* no Authorization → skips Groq tier */ } },
        });

        assert.ok(capturedUrl && capturedUrl.includes('openrouter.ai'),
          `Expected OpenRouter URL, got ${capturedUrl}`);
        assert.ok(capturedConfig && capturedConfig.headers,
          'axios.post received no headers');
        assert.strictEqual(capturedConfig.headers['HTTP-Referer'], 'https://acme.example',
          `HTTP-Referer header wrong (got ${capturedConfig.headers['HTTP-Referer']})`);
        assert.strictEqual(capturedConfig.headers['X-Title'], 'Acme',
          `X-Title header wrong (got ${capturedConfig.headers['X-Title']})`);
      } finally {
        axios.post = origPost;
        purgeCache('../config/brand', '../utils/groq-client');
      }
    } finally {
      restoreEnv(env);
      purgeCache('../config/brand', '../utils/groq-client');
    }
  });

  // --------------------------------------------------------------
  // 2. IPFS pin metadata name uses BRAND.ipfsPrefix
  // --------------------------------------------------------------
  await test('Pinata pin metadata name reflects BRAND_IPFS_PREFIX override', async () => {
    const env = snapshotEnv(['PINATA_JWT']);
    try {
      for (const k of BRAND_KEYS) delete process.env[k];
      process.env.BRAND_IPFS_PREFIX = 'acme-capsule';
      process.env.PINATA_JWT = 'fake-pinata-jwt-for-test';

      const axios = require('axios');
      const origPost = axios.post;
      let capturedBody = null;
      axios.post = async (url, body /*, config */) => {
        capturedBody = body;
        return { data: { IpfsHash: 'QmTest' } };
      };

      try {
        purgeCache('../config/brand', '../utils/ipfs-pinner');
        const { pinJson } = require('../utils/ipfs-pinner');
        const result = await pinJson({ test: 1 });
        assert.deepStrictEqual(result, { cid: 'QmTest' });
        assert.ok(capturedBody && capturedBody.pinataMetadata,
          'pinJson did not pass pinataMetadata');
        assert.match(capturedBody.pinataMetadata.name, /^acme-capsule-\d+$/,
          `pin name should start with override prefix; got "${capturedBody.pinataMetadata.name}"`);
      } finally {
        axios.post = origPost;
        purgeCache('../config/brand', '../utils/ipfs-pinner');
      }
    } finally {
      restoreEnv(env);
      purgeCache('../config/brand', '../utils/ipfs-pinner');
    }
  });

  // --------------------------------------------------------------
  // 3. JWT issuer + audience reflect BRAND_JWT_ISSUER / _AUDIENCE
  //    (and tokens still verify on the same instance).
  // --------------------------------------------------------------
  await test('signAccessToken / verifyToken honor BRAND_JWT_ISSUER + BRAND_JWT_AUDIENCE override', () => {
    const env = snapshotEnv(['SESSION_SECRET']);
    try {
      for (const k of BRAND_KEYS) delete process.env[k];
      process.env.BRAND_JWT_ISSUER = 'acme';
      process.env.BRAND_JWT_AUDIENCE = 'acme-app';
      process.env.SESSION_SECRET = 'test-secret-do-not-use-in-prod';

      purgeCache('../config/brand', '../lib/auth-service');
      const { signAccessToken, verifyToken } = require('../lib/auth-service');

      const token = signAccessToken(42, 'u@example.com', 'user', 1, null, false);
      const decoded = jwt.decode(token);
      assert.strictEqual(decoded.iss, 'acme', `iss wrong (got ${decoded.iss})`);
      assert.strictEqual(decoded.aud, 'acme-app', `aud wrong (got ${decoded.aud})`);
      assert.strictEqual(decoded.userId, 42);

      // Same-instance round-trip must still verify (issuer/audience match).
      const verified = verifyToken(token);
      assert.ok(verified, 'verifyToken returned null on same-instance token');
      assert.strictEqual(verified.iss, 'acme');
      assert.strictEqual(verified.aud, 'acme-app');
    } finally {
      restoreEnv(env);
      purgeCache('../config/brand', '../lib/auth-service');
    }
  });

  // Backward-compat regression: unset env → upstream nyanbook claims preserved.
  await test('JWT defaults preserve upstream nyanbook iss/aud when env is unset', () => {
    const env = snapshotEnv(['SESSION_SECRET']);
    try {
      for (const k of BRAND_KEYS) delete process.env[k];
      process.env.SESSION_SECRET = 'test-secret-do-not-use-in-prod';

      purgeCache('../config/brand', '../lib/auth-service');
      const { signAccessToken } = require('../lib/auth-service');
      const decoded = jwt.decode(signAccessToken(1, 'u@example.com', 'user'));
      assert.strictEqual(decoded.iss, 'nyanbook');
      assert.strictEqual(decoded.aud, 'nyanbook-app');
    } finally {
      restoreEnv(env);
      purgeCache('../config/brand', '../lib/auth-service');
    }
  });

  // --------------------------------------------------------------
  // 4. Email subject templates interpolate BRAND.name (structural).
  //    Email routes require an Express app + DB + Resend; spinning
  //    them up in a unit test is impractical. Instead, lock the
  //    template literal so future edits cannot regress to a hardcoded
  //    'Nyanbook' string in the brandable user-facing copy.
  // --------------------------------------------------------------
  await test('routes/auth.js password-reset subject uses BRAND.name template', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    assert.ok(
      src.includes('subject: `Reset Your ${BRAND.name} Password`'),
      'Password-reset subject must use `Reset Your ${BRAND.name} Password` template'
    );
    assert.ok(
      src.includes("require('../config/brand')"),
      'routes/auth.js must import BRAND from config/brand'
    );
    // Negative: subject line must not still hardcode the old literal.
    assert.ok(
      !/subject:\s*['"`]Reset Your Nyanbook Password['"`]/.test(src),
      'Password-reset subject still contains hardcoded "Reset Your Nyanbook Password"'
    );
  });

  await test('routes/books/shares.js share-invite subject + body interpolate BRAND.name', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'books', 'shares.js'), 'utf8');
    assert.ok(
      src.includes('shared a book with you on ${BRAND.name}`'),
      'Share-invite subject must interpolate ${BRAND.name}'
    );
    assert.ok(
      src.includes('Open ${BRAND.name}'),
      'Share-invite CTA must interpolate ${BRAND.name}'
    );
    assert.ok(
      src.includes("require('../../config/brand')"),
      'routes/books/shares.js must import BRAND from config/brand'
    );
    assert.ok(
      !/shared a book with you on Nyanbook/.test(src),
      'Share-invite subject still contains hardcoded "on Nyanbook"'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
