'use strict';

// Tests for config/brand.js fork-friendly attribution defaults.
//
// Coverage:
//   1. Unset env vars → BRAND fields equal today's literal NyanBook values.
//   2. Set env vars → BRAND fields reflect the override.
//   3. The identity preflight router still classifies "who made nyanbook"
//      as an identity question even when BRAND_NAME=Acme — proving the
//      epistemic anchor is decoupled from the brand surface.

const assert = require('assert');
const path = require('path');

const BRAND_KEYS = [
  'BRAND_NAME', 'BRAND_NAME_LOWER',
  'RESEND_FROM_EMAIL', 'RESEND_FROM_NAME',
  'BRAND_IPFS_PREFIX',
  'BRAND_JWT_ISSUER', 'BRAND_JWT_AUDIENCE',
  'BRAND_OPENROUTER_TITLE', 'BRAND_OPENROUTER_REFERER',
  'BRAND_DATA_SALT',
  'BRAND_BACKUP_PREFIX',
  'BRAND_EXPORT_FORMAT_TAG', 'BRAND_EXPORT_SOURCE_FALLBACK',
];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed++;
  }
}

function withBrandEnv(overrides, fn) {
  const snapshot = {};
  for (const k of BRAND_KEYS) snapshot[k] = process.env[k];
  for (const k of BRAND_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Force a fresh require so the module re-reads process.env.
  const brandPath = require.resolve('../config/brand');
  delete require.cache[brandPath];
  try {
    return fn();
  } finally {
    for (const k of BRAND_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
    delete require.cache[brandPath];
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed++;
  }
}

console.log('\n=== Brand Defaults — fork-friendly attribution ===\n');

test('Unset env → BRAND defaults match upstream NyanBook literals', () => {
  withBrandEnv({}, () => {
    const { BRAND } = require('../config/brand');
    assert.strictEqual(BRAND.name, 'Nyanbook');
    assert.strictEqual(BRAND.nameLower, 'nyanbook');
    assert.strictEqual(BRAND.fromEmail, 'nyan@nyanbook.io');
    assert.strictEqual(BRAND.fromName, 'NyanBook');
    assert.strictEqual(BRAND.ipfsPrefix, 'nyanbook-capsule');
    assert.strictEqual(BRAND.jwtIssuer, 'nyanbook');
    assert.strictEqual(BRAND.jwtAudience, 'nyanbook-app');
    assert.strictEqual(BRAND.openrouterTitle, 'Nyanbook');
    assert.strictEqual(BRAND.openrouterReferer, 'https://nyanbook.io');
    assert.strictEqual(BRAND.dataSalt, 'nyanbook-salt');
    assert.strictEqual(BRAND.backupPrefix, 'nyanbook_backup');
    assert.strictEqual(BRAND.exportFormatTag, 'nyanbook-export');
    assert.strictEqual(BRAND.exportSourceFallback, 'nyanbook');
  });
});

test('Acme override → every brand field reflects the override', () => {
  withBrandEnv({
    BRAND_NAME: 'Acme',
    RESEND_FROM_EMAIL: 'hello@acme.com',
    RESEND_FROM_NAME: 'Acme',
    BRAND_IPFS_PREFIX: 'acme-capsule',
    BRAND_JWT_ISSUER: 'acme',
    BRAND_JWT_AUDIENCE: 'acme-app',
    BRAND_OPENROUTER_TITLE: 'Acme',
    BRAND_OPENROUTER_REFERER: 'https://acme.com',
    BRAND_DATA_SALT: 'acme-salt',
    BRAND_BACKUP_PREFIX: 'acme_backup',
    BRAND_EXPORT_FORMAT_TAG: 'acme-export',
    BRAND_EXPORT_SOURCE_FALLBACK: 'acme',
  }, () => {
    const { BRAND } = require('../config/brand');
    assert.strictEqual(BRAND.name, 'Acme');
    assert.strictEqual(BRAND.nameLower, 'acme', 'nameLower derives from BRAND_NAME when not set');
    assert.strictEqual(BRAND.fromEmail, 'hello@acme.com');
    assert.strictEqual(BRAND.fromName, 'Acme');
    assert.strictEqual(BRAND.ipfsPrefix, 'acme-capsule');
    assert.strictEqual(BRAND.jwtIssuer, 'acme');
    assert.strictEqual(BRAND.jwtAudience, 'acme-app');
    assert.strictEqual(BRAND.openrouterTitle, 'Acme');
    assert.strictEqual(BRAND.openrouterReferer, 'https://acme.com');
    assert.strictEqual(BRAND.dataSalt, 'acme-salt');
    assert.strictEqual(BRAND.backupPrefix, 'acme_backup');
    assert.strictEqual(BRAND.exportFormatTag, 'acme-export');
    assert.strictEqual(BRAND.exportSourceFallback, 'acme');
  });
});

test('BRAND_NAME_LOWER explicit override wins over derived value', () => {
  withBrandEnv({
    BRAND_NAME: 'Acme',
    BRAND_NAME_LOWER: 'ACME-CUSTOM',
  }, () => {
    const { BRAND } = require('../config/brand');
    assert.strictEqual(BRAND.nameLower, 'ACME-CUSTOM');
  });
});

(async () => {
  await asyncTest('Identity router still routes "who made nyanbook" even with BRAND_NAME=Acme', async () => {
    await withBrandEnv({ BRAND_NAME: 'Acme' }, async () => {
      const routerPath = require.resolve('../utils/preflight-router');
      delete require.cache[routerPath];
      const { preflightRouter } = require('../utils/preflight-router');
      const result = await preflightRouter({ query: 'who made nyanbook?' });
      assert.strictEqual(result.mode, 'nyan-identity',
        `Identity question about "nyanbook" must route to nyan-identity even when BRAND_NAME=Acme (got ${result.mode})`);
      assert.strictEqual(result.routingFlags.isNyanIdentity, true);
    });
  });

  await asyncTest('Identity router still routes "apa itu nyanbook" (Indonesian) with BRAND_NAME=Acme', async () => {
    await withBrandEnv({ BRAND_NAME: 'Acme' }, async () => {
      const routerPath = require.resolve('../utils/preflight-router');
      delete require.cache[routerPath];
      const { preflightRouter } = require('../utils/preflight-router');
      const result = await preflightRouter({ query: 'apa itu nyanbook?' });
      assert.strictEqual(result.mode, 'nyan-identity',
        `Indonesian identity question about "nyanbook" must route to nyan-identity (got ${result.mode})`);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
