#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { MigrationRunner } = require('../lib/migration-runner');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyanbook-bootstrap-'));
const dataDir = path.join(root, 'data');
const socketDir = path.join(root, 'socket');
const port = 56000 + (process.pid % 1000);
const database = 'nyanbook_clean';
const user = os.userInfo().username;

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  let started = false;
  let pool;
  try {
    fs.mkdirSync(socketDir);
    run('initdb', ['-D', dataDir, '--auth=trust', '--no-locale']);
    run('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-w', 'start']);
    started = true;
    run('createdb', ['-U', user, '-h', socketDir, '-p', String(port), database]);

    pool = new Pool({ host: socketDir, port, database, user });
    const runner = new MigrationRunner(pool);
    await runner.run();

    const { rows: [tenant] } = await pool.query(
      "INSERT INTO core.tenant_catalog (tenant_schema) VALUES ('tenant_1') RETURNING id"
    );
    await runner.run();

    const { rows: [account] } = await pool.query(
      'INSERT INTO tenant_1.users (email, password_hash, tenant_id) VALUES ($1, $2, $3) RETURNING id',
      ['owner@example.test', 'test-only', tenant.id]
    );

    await pool.query(`
      INSERT INTO tenant_1.user_settings (user_id, onboarding_completed, settings)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE
      SET onboarding_completed = $2, settings = $3, updated_at = NOW()
    `, [account.id, true, JSON.stringify({ welcome: 'complete' })]);
    const { rows: [onboarding] } = await pool.query(
      'SELECT onboarding_completed, settings FROM tenant_1.user_settings WHERE user_id = $1',
      [account.id]
    );

    const { rows: [book] } = await pool.query(`
      INSERT INTO core.book_registry
        (book_name, join_code, fractal_id, tenant_schema, tenant_email, outpipe_ledger)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, ['Smoke Book', 'SMOKE-123', 'book_smoke_123', 'tenant_1', 'owner@example.test', 'ledger']);

    const { rows: [thread] } = await pool.query(
      'UPDATE core.book_registry SET audit_thread_id = $1 WHERE id = $2 AND audit_thread_id IS NULL RETURNING audit_thread_id',
      ['audit-thread-1', book.id]
    );
    await pool.query(
      'UPDATE core.tenant_catalog SET audit_mirror_webhook_url = $1, audit_mirror_thread_id = $2 WHERE tenant_schema = $3',
      ['https://example.test/webhook', 'mirror-thread-1', 'tenant_1']
    );
    const { rows: [mirror] } = await pool.query(
      'SELECT audit_mirror_thread_id, audit_mirror_webhook_url FROM core.tenant_catalog WHERE tenant_schema = $1',
      ['tenant_1']
    );

    const [{ rows: [core] }, { rows: [tenantMigrations] }] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM core.migrations'),
      pool.query("SELECT COUNT(*)::int AS count FROM core.tenant_migrations WHERE tenant_schema = 'tenant_1'"),
    ]);
    const migrationDir = path.join(__dirname, '..', 'migrations');
    const expectedCore = fs.readdirSync(path.join(migrationDir, 'core')).filter(name => name.endsWith('.sql')).length;
    const expectedTenant = fs.readdirSync(path.join(migrationDir, 'tenant')).filter(name => name.endsWith('.sql')).length;

    assert(core.count === expectedCore, `expected ${expectedCore} core migrations, got ${core.count}`);
    assert(tenantMigrations.count === expectedTenant, `expected ${expectedTenant} tenant migrations, got ${tenantMigrations.count}`);
    assert(onboarding.onboarding_completed && onboarding.settings.welcome === 'complete', 'onboarding read/write failed');
    assert(thread.audit_thread_id === 'audit-thread-1', 'audit thread read/write failed');
    assert(
      mirror.audit_mirror_thread_id === 'mirror-thread-1' &&
      mirror.audit_mirror_webhook_url === 'https://example.test/webhook',
      'audit mirror read/write failed'
    );
    console.log(`✅ Clean bootstrap: ${expectedCore} core + ${expectedTenant} tenant migrations, onboarding, and audit paths passed.`);
  } finally {
    if (pool) await pool.end();
    if (started) {
      try { run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`❌ Clean bootstrap failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});