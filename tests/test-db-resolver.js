'use strict';

const assert = require('assert');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'db-resolver.js');

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

function withEnv(overrides, fn) {
  const snapshot = {};
  const keys = ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT', 'DATABASE_CA_CERT'];
  for (const k of keys) snapshot[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[MODULE_PATH];
  try {
    return fn(require(MODULE_PATH));
  } finally {
    for (const k of keys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
    delete require.cache[MODULE_PATH];
  }
}

console.log('\n── db-resolver: host classification ──');

withEnv({}, (mod) => {
  test('loopback: 127.0.0.1', () => assert.strictEqual(mod.isLoopbackHost('127.0.0.1'), true));
  test('loopback: 127.5.5.5', () => assert.strictEqual(mod.isLoopbackHost('127.5.5.5'), true));
  test('loopback: ::1', () => assert.strictEqual(mod.isLoopbackHost('::1'), true));
  test('loopback: [::1]', () => assert.strictEqual(mod.isLoopbackHost('[::1]'), true));
  test('loopback: localhost', () => assert.strictEqual(mod.isLoopbackHost('localhost'), true));
  test('loopback: not 8.8.8.8', () => assert.strictEqual(mod.isLoopbackHost('8.8.8.8'), false));

  test('private: 10.0.0.5', () => assert.strictEqual(mod.isPrivateIPv4('10.0.0.5'), true));
  test('private: 172.16.0.1', () => assert.strictEqual(mod.isPrivateIPv4('172.16.0.1'), true));
  test('private: 172.31.255.1', () => assert.strictEqual(mod.isPrivateIPv4('172.31.255.1'), true));
  test('private: not 172.32.0.1', () => assert.strictEqual(mod.isPrivateIPv4('172.32.0.1'), false));
  test('private: 192.168.1.1', () => assert.strictEqual(mod.isPrivateIPv4('192.168.1.1'), true));
  test('private: not 8.8.8.8', () => assert.strictEqual(mod.isPrivateIPv4('8.8.8.8'), false));
  test('private: not 192.169.1.1', () => assert.strictEqual(mod.isPrivateIPv4('192.169.1.1'), false));

  test('isPrivateOrLoopback: handles both', () => {
    assert.strictEqual(mod.isPrivateOrLoopback('10.0.0.1'), true);
    assert.strictEqual(mod.isPrivateOrLoopback('::1'), true);
    assert.strictEqual(mod.isPrivateOrLoopback('aws-1-ap-northeast-1.pooler.supabase.com'), false);
  });
});

console.log('\n── db-resolver: PgBouncer detection ──');

withEnv({}, (mod) => {
  test('pgbouncer host', () => assert.strictEqual(mod.isPgBouncerHost('myhost.pgbouncer.example.com'), true));
  test('Supabase pooler', () => assert.strictEqual(mod.isPgBouncerHost('aws-1-ap-northeast-1.pooler.supabase.com'), true));
  test('Neon pooler', () => assert.strictEqual(mod.isPgBouncerHost('ep-x.pooler.neon.tech'), true));
  test('not direct host', () => assert.strictEqual(mod.isPgBouncerHost('db.neon.tech'), false));
  test('not RDS', () => assert.strictEqual(mod.isPgBouncerHost('mydb.us-east-1.rds.amazonaws.com'), false));
});

console.log('\n── db-resolver: URL parsing ──');

withEnv({}, (mod) => {
  test('parseHost: standard URL', () => {
    assert.strictEqual(mod.parseHost('postgres://u:p@db.example.com:5432/mydb'), 'db.example.com');
  });
  test('parseHost: no userinfo', () => {
    assert.strictEqual(mod.parseHost('postgres://db.example.com/mydb'), 'db.example.com');
  });
  test('parseHost: IPv6', () => {
    assert.strictEqual(mod.parseHost('postgres://u:p@[::1]:5432/mydb'), '::1');
  });
  test('isSingleLabelHost: helium → true', () => assert.strictEqual(mod.isSingleLabelHost('helium'), true));
  test('isSingleLabelHost: db.example.com → false', () => assert.strictEqual(mod.isSingleLabelHost('db.example.com'), false));
  test('isSingleLabelHost: 10.0.0.1 → false', () => assert.strictEqual(mod.isSingleLabelHost('10.0.0.1'), false));
  test('parseHost: pgConfig object', () => {
    assert.strictEqual(mod.parseHost({ host: 'pg.local' }), 'pg.local');
  });
  test('parseHost: malformed fallback', () => {
    assert.strictEqual(mod.parseHost('not-a-url'), 'not-a-url');
  });

  test('shortHost: FQDN → first label', () => {
    assert.strictEqual(mod.shortHost('aws-1-ap-northeast-1.pooler.supabase.com'), 'aws-1-ap-northeast-1');
  });
  test('shortHost: private IP preserved', () => {
    assert.strictEqual(mod.shortHost('10.0.0.5'), '10.0.0.5');
  });
});

console.log('\n── db-resolver: pool_mode appending ──');

withEnv({}, (mod) => {
  test('pgbouncer URL gets pool_mode', () => {
    const out = mod.buildConnectionStringFromUrl('postgres://u:p@my.pooler.supabase.com:6543/db');
    assert.ok(out.includes('pool_mode=transaction'), out);
  });
  test('pgbouncer URL with existing params uses &', () => {
    const out = mod.buildConnectionStringFromUrl('postgres://u:p@my.pooler.supabase.com:6543/db?sslmode=require');
    assert.ok(out.includes('?sslmode=require&pool_mode=transaction'), out);
  });
  test('direct host does NOT get pool_mode', () => {
    const out = mod.buildConnectionStringFromUrl('postgres://u:p@db.neon.tech:5432/db');
    assert.strictEqual(out.includes('pool_mode'), false);
  });
  test('localhost does NOT get pool_mode', () => {
    const out = mod.buildConnectionStringFromUrl('postgres://u:p@localhost:5432/db');
    assert.strictEqual(out.includes('pool_mode'), false);
  });
});

console.log('\n── db-resolver: SSL derivation ──');

withEnv({}, (mod) => {
  test('SSL off for loopback', () => assert.strictEqual(mod.buildSslConfig('127.0.0.1'), false));
  test('SSL off for ::1', () => assert.strictEqual(mod.buildSslConfig('::1'), false));
  test('SSL off for RFC1918', () => assert.strictEqual(mod.buildSslConfig('10.0.0.5'), false));
  test('SSL on for public host', () => {
    const s = mod.buildSslConfig('db.neon.tech');
    assert.ok(s && typeof s === 'object');
    assert.strictEqual(s.rejectUnauthorized, false);
  });
});

withEnv({ DATABASE_CA_CERT: '-----FAKE-----' }, (mod) => {
  test('SSL with custom CA → rejectUnauthorized:true + ca attached', () => {
    const s = mod.buildSslConfig('db.neon.tech');
    assert.strictEqual(s.rejectUnauthorized, true);
    assert.strictEqual(s.ca, '-----FAKE-----');
  });
});

console.log('\n── db-resolver: PG* var collection ──');

withEnv({ PGHOST: 'h', PGUSER: 'u', PGPASSWORD: 'pw', PGDATABASE: 'd', PGPORT: '5433' }, (mod) => {
  test('getPgEnvVars: full set', () => {
    const v = mod.getPgEnvVars();
    assert.deepStrictEqual(v, { host: 'h', user: 'u', password: 'pw', database: 'd', port: 5433 });
  });
});

withEnv({ PGHOST: 'h', PGUSER: 'u', PGDATABASE: 'd' }, (mod) => {
  test('getPgEnvVars: missing password OK (empty)', () => {
    const v = mod.getPgEnvVars();
    assert.strictEqual(v.password, '');
    assert.strictEqual(v.port, 5432);
  });
});

withEnv({ PGHOST: 'h' }, (mod) => {
  test('getPgEnvVars: incomplete → null', () => {
    assert.strictEqual(mod.getPgEnvVars(), null);
  });
});

console.log('\n── db-resolver: resolution branches (skipHandshake) ──');

withEnv({ DATABASE_URL: 'postgres://u:p@db.neon.tech/mydb' }, (mod) => {
  test('DATABASE_URL only → source=DATABASE_URL', () => {
    const r = mod.resolveDatabase({ skipHandshake: true });
    assert.strictEqual(r.source, 'DATABASE_URL');
    assert.strictEqual(r.host, 'db.neon.tech');
    assert.ok(r.connectionString.startsWith('postgres://'));
  });
});

withEnv({ PGHOST: 'h', PGUSER: 'u', PGPASSWORD: 'pw', PGDATABASE: 'd' }, (mod) => {
  test('PG* only → source=PG_VARS', () => {
    const r = mod.resolveDatabase({ skipHandshake: true });
    assert.strictEqual(r.source, 'PG_VARS');
    assert.strictEqual(r.pgConfig.host, 'h');
  });
});

withEnv({}, (mod) => {
  test('Both missing → throws', () => {
    assert.throws(() => mod.resolveDatabase({ skipHandshake: true }), /No working PostgreSQL source/);
  });
});

console.log('\n── db-resolver: mocked handshake fallback ──');

// Deterministic fallback test: stub child_process.spawnSync so we can drive
// handshake outcomes without needing a real Postgres anywhere. Captures the
// candidate config passed to each handshake call and asserts the resolver
// returns the same object (parity contract).
function withMockedHandshake(scenarios, fn) {
  const cp = require('child_process');
  const original = cp.spawnSync;
  const captured = [];
  let i = 0;
  cp.spawnSync = (cmd, args, opts) => {
    const cfg = JSON.parse(opts.env.__CFG);
    captured.push(cfg);
    const outcome = scenarios[i++] || { ok: true };
    if (outcome.ok) return { status: 0, stdout: '', stderr: '' };
    return { status: 2, stdout: '', stderr: JSON.stringify({ code: outcome.code || 'ERR', message: outcome.message || 'mocked failure' }) };
  };
  try { return fn(captured); } finally { cp.spawnSync = original; }
}

withEnv({
  DATABASE_URL: 'postgres://u:p@db.example.com:5432/db',
  PGHOST: 'pg.local', PGUSER: 'u', PGPASSWORD: 'pw', PGDATABASE: 'd',
}, (mod) => {
  test('mocked: bad DATABASE_URL falls through to PG*', () => {
    withMockedHandshake([{ ok: false, code: 'ECONNREFUSED' }, { ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      assert.strictEqual(r.source, 'PG_VARS');
      assert.strictEqual(r.attempts.length, 1);
      assert.strictEqual(r.attempts[0].code, 'ECONNREFUSED');
      assert.strictEqual(captured.length, 2);
    });
  });

  test('mocked: handshake candidate matches runtime resolution (URL path)', () => {
    withMockedHandshake([{ ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      assert.strictEqual(r.source, 'DATABASE_URL');
      assert.strictEqual(captured[0].connectionString, r.connectionString);
      assert.deepStrictEqual(captured[0].ssl, r.ssl);
    });
  });

  test('mocked: handshake candidate matches runtime resolution (PG* fallback path)', () => {
    withMockedHandshake([{ ok: false, code: 'ENOTFOUND' }, { ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      assert.strictEqual(r.source, 'PG_VARS');
      // Second handshake = PG* candidate; must equal runtime pgConfig + ssl.
      assert.strictEqual(captured[1].host, r.pgConfig.host);
      assert.strictEqual(captured[1].user, r.pgConfig.user);
      assert.strictEqual(captured[1].database, r.pgConfig.database);
      assert.deepStrictEqual(captured[1].ssl, r.ssl);
    });
  });

  test('mocked: both fail → throws with both attempts logged', () => {
    withMockedHandshake([
      { ok: false, code: 'ECONNREFUSED', message: 'url dead' },
      { ok: false, code: '28P01', message: 'pg auth fail' },
    ], () => {
      let err;
      try { mod.resolveDatabase(); } catch (e) { err = e; }
      assert.ok(err, 'should throw');
      assert.strictEqual(err.attempts.length, 2);
      assert.strictEqual(err.attempts[0].source, 'DATABASE_URL');
      assert.strictEqual(err.attempts[1].source, 'PG_VARS');
      assert.match(err.message, /No working PostgreSQL source/);
    });
  });
});

withEnv({ PGHOST: 'h', PGUSER: 'u', PGPASSWORD: 'pw', PGDATABASE: 'd' }, (mod) => {
  test('mocked: PG*-only succeeds without any URL handshake', () => {
    withMockedHandshake([{ ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      assert.strictEqual(r.source, 'PG_VARS');
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(captured[0].host, 'h');
    });
  });
});

console.log('\n── db-resolver: handshake↔pool config parity (strict) ──');

// Locks the contract from Task #166: the EXACT object handed to tryHandshake
// must be the same shape later passed to `new Pool(...)` in vegapunk.js,
// i.e. { connectionString, ssl } for the URL branch and { ...pgConfig, ssl }
// for the PG* branch. Stubs spawnSync (no env gating, no real Postgres) so
// CI cannot silently skip this regression.

withEnv({ DATABASE_URL: 'postgres://u:p@db.neon.tech:5432/mydb' }, (mod) => {
  test('parity: URL branch — captured candidate ≡ { connectionString, ssl }', () => {
    withMockedHandshake([{ ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      assert.strictEqual(captured.length, 1);
      const expected = { connectionString: r.connectionString, ssl: r.ssl };
      assert.deepStrictEqual(captured[0], expected);
      // And the keys are exactly these two — no extras, no omissions.
      assert.deepStrictEqual(Object.keys(captured[0]).sort(), ['connectionString', 'ssl']);
    });
  });
});

withEnv({ DATABASE_URL: 'postgres://u:p@my.pooler.supabase.com:6543/db?sslmode=require' }, (mod) => {
  test('parity: URL branch (pgbouncer) — pool_mode preserved into handshake', () => {
    withMockedHandshake([{ ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      const expected = { connectionString: r.connectionString, ssl: r.ssl };
      assert.deepStrictEqual(captured[0], expected);
      assert.ok(captured[0].connectionString.includes('pool_mode=transaction'));
    });
  });
});

withEnv({ PGHOST: 'pg.example.com', PGUSER: 'u', PGPASSWORD: 'pw', PGDATABASE: 'd', PGPORT: '5433' }, (mod) => {
  test('parity: PG* branch — captured candidate ≡ { ...pgConfig, ssl }', () => {
    withMockedHandshake([{ ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      assert.strictEqual(captured.length, 1);
      const expected = { ...r.pgConfig, ssl: r.ssl };
      assert.deepStrictEqual(captured[0], expected);
      assert.deepStrictEqual(
        Object.keys(captured[0]).sort(),
        ['database', 'host', 'password', 'port', 'ssl', 'user']
      );
    });
  });
});

withEnv({
  DATABASE_URL: 'postgres://u:p@db.neon.tech:5432/mydb',
  PGHOST: 'pg.example.com', PGUSER: 'u', PGPASSWORD: 'pw', PGDATABASE: 'd',
}, (mod) => {
  test('parity: URL fails → PG* candidate also matches runtime { ...pgConfig, ssl }', () => {
    withMockedHandshake([{ ok: false, code: 'ECONNREFUSED' }, { ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      assert.strictEqual(r.source, 'PG_VARS');
      assert.strictEqual(captured.length, 2);
      assert.deepStrictEqual(captured[1], { ...r.pgConfig, ssl: r.ssl });
    });
  });
});

withEnv({ DATABASE_URL: 'postgres://u:p@db.neon.tech:5432/mydb', DATABASE_CA_CERT: '-----FAKE-CA-----' }, (mod) => {
  test('parity: URL branch with custom CA — ssl object propagates verbatim', () => {
    withMockedHandshake([{ ok: true }], (captured) => {
      const r = mod.resolveDatabase();
      assert.deepStrictEqual(captured[0], { connectionString: r.connectionString, ssl: r.ssl });
      assert.strictEqual(captured[0].ssl.rejectUnauthorized, true);
      assert.strictEqual(captured[0].ssl.ca, '-----FAKE-CA-----');
    });
  });
});

console.log('\n── db-resolver: active-resolution singleton ──');

withEnv({}, (mod) => {
  test('getActiveResolution starts null', () => {
    assert.strictEqual(mod.getActiveResolution(), null);
  });
  test('setActiveResolution / getActiveResolution roundtrip', () => {
    const sample = { source: 'DATABASE_URL', host: 'h', shortHost: 'h', connectionString: 'x', ssl: false, attempts: [] };
    mod.setActiveResolution(sample);
    assert.strictEqual(mod.getActiveResolution(), sample);
    mod.setActiveResolution(null);
  });
});

console.log('\n── db-resolver: handshake-runtime config parity ──');

withEnv({
  DATABASE_URL: 'postgres://nope:nope@10.255.255.1:5432/none',
  PGHOST: process.env.__REAL_PGHOST,
  PGUSER: process.env.__REAL_PGUSER,
  PGPASSWORD: process.env.__REAL_PGPASSWORD,
  PGDATABASE: process.env.__REAL_PGDATABASE,
  PGPORT: process.env.__REAL_PGPORT,
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nINVALID\n-----END CERTIFICATE-----\n',
}, (mod) => {
  if (!process.env.PGHOST) {
    test('invalid CA forces URL rejection (skipped — no real PG*)', () => {});
    return;
  }
  test('invalid DATABASE_CA_CERT → URL handshake fails → falls back to PG*', () => {
    // PG* host here ('helium') is single-label → SSL off → CA ignored,
    // so PG* should still succeed while the URL candidate fails.
    const r = mod.resolveDatabase();
    assert.strictEqual(r.source, 'PG_VARS', `attempts=${JSON.stringify(r.attempts)}`);
    assert.ok(r.attempts.length === 1);
    assert.strictEqual(r.attempts[0].source, 'DATABASE_URL');
  });
});

withEnv({ DATABASE_URL: 'postgres://u:p@host.example.com:5432/db' }, (mod) => {
  test('handshake candidate uses connectionString from buildConnectionStringFromUrl', () => {
    // Public host with no DATABASE_CA_CERT → ssl object with rejectUnauthorized:false.
    // Verify the resolver builds a full runtime config (not a stripped proxy).
    const r = mod.resolveDatabase({ skipHandshake: true });
    assert.strictEqual(r.connectionString, 'postgres://u:p@host.example.com:5432/db');
    assert.deepStrictEqual(r.ssl, { rejectUnauthorized: false });
  });
});

withEnv({ DATABASE_URL: 'postgres://u:p@my.pooler.example.com:6543/db' }, (mod) => {
  test('handshake candidate carries pool_mode for pgbouncer hosts', () => {
    const r = mod.resolveDatabase({ skipHandshake: true });
    assert.ok(r.connectionString.includes('pool_mode=transaction'));
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
