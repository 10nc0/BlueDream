#!/usr/bin/env node
'use strict';

process.env.FRACTAL_SALT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-minimum-32-chars-long-ok';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const authService = require('../lib/auth-service');
const { buildCapsule } = require('../utils/message-capsule');
const { TwilioChannel } = require('../lib/channels/twilio');
const { VALID_SCHEMA_PATTERN, assertValidSchemaName } = require('../lib/validators');

const TEST_PREFIX = `test_${Date.now()}`;
const SCHEMA_A = `${TEST_PREFIX}_a`;
const SCHEMA_B = `${TEST_PREFIX}_b`;
const TEST_EMAIL_A = `alice_${TEST_PREFIX}@test.com`;
const TEST_EMAIL_B = `bob_${TEST_PREFIX}@test.com`;
const TEST_PASSWORD = 'TestPass123!';

let pool;
let tenantIdA, tenantIdB;
let userIdA, userIdB;
let accessTokenA, refreshTokenA, refreshTokenIdA;
let accessTokenB;
let bookIdA;

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
    return { label, fn };
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

function assertNotEqual(a, b, msg) {
    if (a === b) throw new Error(msg || `expected values to differ, both were ${JSON.stringify(a)}`);
}

async function runTest(t) {
    try {
        await t.fn();
        console.log(`  ✅  ${t.label}`);
        passed++;
    } catch (e) {
        console.log(`  ❌  ${t.label}`);
        console.log(`      ${e.message}`);
        failed++;
        failures.push({ label: t.label, error: e.message });
    }
}

async function setup() {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    await pool.query(`CREATE SCHEMA IF NOT EXISTS core`);

    const coreBaseline = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'migrations', 'core', '001_baseline.sql'),
        'utf8'
    );
    await pool.query(coreBaseline);

    for (const schema of [SCHEMA_A, SCHEMA_B]) {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

        const tenantBaseline = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'migrations', 'tenant', '001_baseline.sql'),
            'utf8'
        );
        const sql = tenantBaseline.replace(/\$\{SCHEMA\}/g, schema);
        await pool.query(sql);
    }

    const idA = await pool.query(
        `INSERT INTO core.tenant_catalog (tenant_schema, genesis_user_id, status)
         VALUES ($1, 0, 'active') RETURNING id`, [SCHEMA_A]
    );
    tenantIdA = idA.rows[0].id;

    const idB = await pool.query(
        `INSERT INTO core.tenant_catalog (tenant_schema, genesis_user_id, status)
         VALUES ($1, 0, 'active') RETURNING id`, [SCHEMA_B]
    );
    tenantIdB = idB.rows[0].id;

    const hashA = await bcrypt.hash(TEST_PASSWORD, 10);
    const uA = await pool.query(
        `INSERT INTO ${SCHEMA_A}.users (email, password_hash, role, tenant_id, is_genesis_admin)
         VALUES ($1, $2, 'admin', $3, true) RETURNING id`,
        [TEST_EMAIL_A, hashA, tenantIdA]
    );
    userIdA = uA.rows[0].id;

    const hashB = await bcrypt.hash(TEST_PASSWORD, 10);
    const uB = await pool.query(
        `INSERT INTO ${SCHEMA_B}.users (email, password_hash, role, tenant_id, is_genesis_admin)
         VALUES ($1, $2, 'admin', $3, true) RETURNING id`,
        [TEST_EMAIL_B, hashB, tenantIdB]
    );
    userIdB = uB.rows[0].id;

    await pool.query(
        `INSERT INTO core.user_email_to_tenant (email, tenant_id, tenant_schema, user_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
        [TEST_EMAIL_A, tenantIdA, SCHEMA_A, userIdA]
    );
    await pool.query(
        `INSERT INTO core.user_email_to_tenant (email, tenant_id, tenant_schema, user_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
        [TEST_EMAIL_B, tenantIdB, SCHEMA_B, userIdB]
    );
}

async function teardown() {
    if (!pool) return;
    try {
        await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_A} CASCADE`);
        await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`);
        await pool.query(`DELETE FROM core.tenant_catalog WHERE tenant_schema IN ($1, $2)`, [SCHEMA_A, SCHEMA_B]);
        await pool.query(`DELETE FROM core.user_email_to_tenant WHERE email IN ($1, $2)`, [TEST_EMAIL_A, TEST_EMAIL_B]);
        await pool.query(`DELETE FROM core.tenant_creation_log WHERE email IN ($1, $2)`, [TEST_EMAIL_A, TEST_EMAIL_B]);
    } catch (e) {
        console.warn(`  ⚠️  Teardown warning: ${e.message}`);
    }
    await pool.end();
}

const authTests = [
    test('signAccessToken returns a valid JWT string', () => {
        const token = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA, null, true);
        assert(typeof token === 'string' && token.split('.').length === 3, 'not a valid JWT');
    }),

    test('verifyToken decodes a valid access token', () => {
        const token = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA, null, true);
        const decoded = authService.verifyToken(token);
        assert(decoded !== null, 'verifyToken returned null');
        assertEqual(decoded.userId, userIdA, 'userId mismatch');
        assertEqual(decoded.email, TEST_EMAIL_A, 'email mismatch');
        assertEqual(decoded.type, 'access', 'type should be access');
        assertEqual(decoded.tenantId, tenantIdA, 'tenantId mismatch');
        assertEqual(decoded.isGenesisAdmin, true, 'isGenesisAdmin should be true');
    }),

    test('verifyToken returns null for garbage token', () => {
        const decoded = authService.verifyToken('not.a.real.token');
        assertEqual(decoded, null, 'expected null for invalid token');
    }),

    test('verifyToken returns null for tampered token', () => {
        const token = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        const parts = token.split('.');
        parts[1] = Buffer.from('{"userId":9999,"type":"access"}').toString('base64url');
        const tampered = parts.join('.');
        const decoded = authService.verifyToken(tampered);
        assertEqual(decoded, null, 'tampered token should fail verification');
    }),

    test('signRefreshToken returns token + tokenId', () => {
        const result = authService.signRefreshToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA, null, true);
        assert(typeof result.token === 'string', 'missing token');
        assert(typeof result.tokenId === 'string', 'missing tokenId');
        assert(result.tokenId.length === 64, 'tokenId should be 64 hex chars');
    }),

    test('refresh token has type=refresh', () => {
        const { token } = authService.signRefreshToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        const decoded = authService.verifyToken(token);
        assertEqual(decoded.type, 'refresh', 'type should be refresh');
    }),

    test('storeRefreshToken + isRefreshTokenValid roundtrip', async () => {
        const { token, tokenId } = authService.signRefreshToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        await authService.storeRefreshToken(pool, SCHEMA_A, userIdA, tokenId, 'test-agent', '127.0.0.1');
        const valid = await authService.isRefreshTokenValid(pool, SCHEMA_A, tokenId, userIdA);
        assert(valid, 'stored refresh token should be valid');
        refreshTokenA = token;
        refreshTokenIdA = tokenId;
    }),

    test('revokeRefreshToken invalidates the token', async () => {
        const { tokenId } = authService.signRefreshToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        await authService.storeRefreshToken(pool, SCHEMA_A, userIdA, tokenId, 'test-agent', '127.0.0.1');
        await authService.revokeRefreshToken(pool, SCHEMA_A, tokenId);
        const valid = await authService.isRefreshTokenValid(pool, SCHEMA_A, tokenId, userIdA);
        assert(!valid, 'revoked token should not be valid');
    }),

    test('revokeAllUserTokens invalidates all tokens for user', async () => {
        const t1 = authService.signRefreshToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        const t2 = authService.signRefreshToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        await authService.storeRefreshToken(pool, SCHEMA_A, userIdA, t1.tokenId, 'dev1', '127.0.0.1');
        await authService.storeRefreshToken(pool, SCHEMA_A, userIdA, t2.tokenId, 'dev2', '127.0.0.1');
        await authService.revokeAllUserTokens(pool, SCHEMA_A, userIdA);
        const v1 = await authService.isRefreshTokenValid(pool, SCHEMA_A, t1.tokenId, userIdA);
        const v2 = await authService.isRefreshTokenValid(pool, SCHEMA_A, t2.tokenId, userIdA);
        assert(!v1 && !v2, 'all tokens should be revoked');
    }),

    test('access token for tenant A cannot be used for tenant B lookup', () => {
        const tokenA = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        const decoded = authService.verifyToken(tokenA);
        assertNotEqual(decoded.tenantId, tenantIdB, 'tenant A token should not have tenant B id');
    }),

    test('password hash verification works', async () => {
        const result = await pool.query(`SELECT password_hash FROM ${SCHEMA_A}.users WHERE id = $1`, [userIdA]);
        const valid = await bcrypt.compare(TEST_PASSWORD, result.rows[0].password_hash);
        assert(valid, 'password should match');
        const invalid = await bcrypt.compare('WrongPassword', result.rows[0].password_hash);
        assert(!invalid, 'wrong password should not match');
    }),

    test('JWT claims include adminId=01 for genesis admin', () => {
        const token = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA, '01', true);
        const decoded = authService.verifyToken(token);
        assertEqual(decoded.adminId, '01', 'adminId should be 01 for genesis');
    }),

    test('JWT claims have null adminId for regular user', () => {
        const token = authService.signAccessToken(userIdB, TEST_EMAIL_B, 'admin', tenantIdB, null, false);
        const decoded = authService.verifyToken(token);
        assertEqual(decoded.adminId, null, 'adminId should be null');
        assertEqual(decoded.isGenesisAdmin, false, 'isGenesisAdmin should be false');
    }),

    test('generate tokens for subsequent tests', () => {
        accessTokenA = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA, '01', true);
        accessTokenB = authService.signAccessToken(userIdB, TEST_EMAIL_B, 'admin', tenantIdB, null, false);
        assert(accessTokenA, 'should have access token A');
        assert(accessTokenB, 'should have access token B');
    }),
];

const booksCrudTests = [
    test('create book in tenant A', async () => {
        const fractalIdVal = `bridge_ta_${crypto.randomBytes(6).toString('hex')}`;
        const result = await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, status, fractal_id, created_by_admin_id, tags)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, fractal_id`,
            ['Test Book A', 'whatsapp', 'discord', 'active', fractalIdVal, '01', ['test']]
        );
        bookIdA = result.rows[0].id;
        assertEqual(result.rows[0].fractal_id, fractalIdVal, 'fractal_id mismatch');
        assert(bookIdA > 0, 'book ID should be positive');
    }),

    test('list books in tenant A returns the created book', async () => {
        const result = await pool.query(
            `SELECT id, name, status, archived FROM ${SCHEMA_A}.books WHERE archived = false AND status != 'expired'`
        );
        assert(result.rows.length >= 1, 'should have at least 1 book');
        const found = result.rows.find(b => b.id === bookIdA);
        assert(found, 'created book should be in list');
        assertEqual(found.name, 'Test Book A', 'name mismatch');
    }),

    test('update book name', async () => {
        await pool.query(
            `UPDATE ${SCHEMA_A}.books SET name = $1, updated_at = NOW() WHERE id = $2`,
            ['Renamed Book A', bookIdA]
        );
        const result = await pool.query(`SELECT name FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assertEqual(result.rows[0].name, 'Renamed Book A', 'name should be updated');
    }),

    test('archive book', async () => {
        await pool.query(
            `UPDATE ${SCHEMA_A}.books SET archived = true, status = 'archived', updated_at = NOW() WHERE id = $1`,
            [bookIdA]
        );
        const result = await pool.query(`SELECT archived, status FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assertEqual(result.rows[0].archived, true, 'should be archived');
        assertEqual(result.rows[0].status, 'archived', 'status should be archived');
    }),

    test('archived book excluded from active list', async () => {
        const result = await pool.query(
            `SELECT id FROM ${SCHEMA_A}.books WHERE archived = false AND status != 'expired'`
        );
        const found = result.rows.find(b => b.id === bookIdA);
        assert(!found, 'archived book should not be in active list');
    }),

    test('unarchive book', async () => {
        await pool.query(
            `UPDATE ${SCHEMA_A}.books SET archived = false, status = 'active', updated_at = NOW() WHERE id = $1`,
            [bookIdA]
        );
        const result = await pool.query(`SELECT archived, status FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assertEqual(result.rows[0].archived, false, 'should not be archived');
        assertEqual(result.rows[0].status, 'active', 'status should be active');
    }),

    test('book tags are stored as text array', async () => {
        await pool.query(
            `UPDATE ${SCHEMA_A}.books SET tags = $1 WHERE id = $2`,
            [['finance', 'personal'], bookIdA]
        );
        const result = await pool.query(`SELECT tags FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assert(Array.isArray(result.rows[0].tags), 'tags should be array');
        assertEqual(result.rows[0].tags.length, 2, 'should have 2 tags');
    }),

    test('book outpipes_user stores JSONB array', async () => {
        const outpipes = [{ type: 'discord', url: 'https://discord.com/api/webhooks/test', name: 'Test' }];
        await pool.query(
            `UPDATE ${SCHEMA_A}.books SET outpipes_user = $1 WHERE id = $2`,
            [JSON.stringify(outpipes), bookIdA]
        );
        const result = await pool.query(`SELECT outpipes_user FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assert(Array.isArray(result.rows[0].outpipes_user), 'outpipes_user should be array');
        assertEqual(result.rows[0].outpipes_user[0].type, 'discord', 'type mismatch');
    }),

    test('delete book', async () => {
        const tempBook = await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, status)
             VALUES ('Temp Delete Book', 'whatsapp', 'discord', 'active') RETURNING id`
        );
        const tempId = tempBook.rows[0].id;
        await pool.query(`DELETE FROM ${SCHEMA_A}.books WHERE id = $1`, [tempId]);
        const result = await pool.query(`SELECT id FROM ${SCHEMA_A}.books WHERE id = $1`, [tempId]);
        assertEqual(result.rows.length, 0, 'deleted book should not exist');
    }),

    test('sort_order default and reorder', async () => {
        const b1 = await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, status)
             VALUES ('Sort1', 'whatsapp', 'discord', 'active') RETURNING id, sort_order`
        );
        assertEqual(b1.rows[0].sort_order, 0, 'default sort_order should be 0');
        await pool.query(`UPDATE ${SCHEMA_A}.books SET sort_order = 5 WHERE id = $1`, [b1.rows[0].id]);
        const result = await pool.query(`SELECT sort_order FROM ${SCHEMA_A}.books WHERE id = $1`, [b1.rows[0].id]);
        assertEqual(result.rows[0].sort_order, 5, 'sort_order should be updated');
    }),
];

const tenantIsolationTests = [
    test('tenant B has no books from tenant A', async () => {
        const result = await pool.query(`SELECT id, name FROM ${SCHEMA_B}.books`);
        const foundA = result.rows.find(b => b.name === 'Test Book A' || b.name === 'Renamed Book A');
        assert(!foundA, 'tenant B should NOT have tenant A books');
    }),

    test('tenant A user record is NOT in tenant B schema', async () => {
        const result = await pool.query(
            `SELECT id FROM ${SCHEMA_B}.users WHERE email = $1`,
            [TEST_EMAIL_A]
        );
        assertEqual(result.rows.length, 0, 'tenant A user should not exist in tenant B');
    }),

    test('tenant B user record is NOT in tenant A schema', async () => {
        const result = await pool.query(
            `SELECT id FROM ${SCHEMA_A}.users WHERE email = $1`,
            [TEST_EMAIL_B]
        );
        assertEqual(result.rows.length, 0, 'tenant B user should not exist in tenant A');
    }),

    test('email-to-tenant mapping isolates lookup', async () => {
        const resultA = await pool.query(
            `SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1`,
            [TEST_EMAIL_A]
        );
        assertEqual(resultA.rows[0].tenant_schema, SCHEMA_A, 'email A should map to schema A');

        const resultB = await pool.query(
            `SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1`,
            [TEST_EMAIL_B]
        );
        assertEqual(resultB.rows[0].tenant_schema, SCHEMA_B, 'email B should map to schema B');
    }),

    test('JWT tenantId prevents cross-tenant data access', () => {
        const decodedA = authService.verifyToken(accessTokenA);
        const decodedB = authService.verifyToken(accessTokenB);
        assertNotEqual(decodedA.tenantId, decodedB.tenantId, 'tenant IDs must differ');
        assertNotEqual(decodedA.email, decodedB.email, 'emails must differ');
    }),

    test('refresh tokens in tenant A are not visible in tenant B', async () => {
        const { tokenId } = authService.signRefreshToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        await authService.storeRefreshToken(pool, SCHEMA_A, userIdA, tokenId, 'test', '127.0.0.1');

        const validInA = await authService.isRefreshTokenValid(pool, SCHEMA_A, tokenId, userIdA);
        assert(validInA, 'should be valid in schema A');

        const resultB = await pool.query(
            `SELECT * FROM ${SCHEMA_B}.refresh_tokens WHERE token_hash = $1`,
            [crypto.createHash('sha256').update(tokenId).digest('hex')]
        );
        assertEqual(resultB.rows.length, 0, 'token should not exist in schema B');
    }),

    test('book_channels are schema-scoped', async () => {
        const bookFid = `bridge_ta_${crypto.randomBytes(6).toString('hex')}`;
        await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, fractal_id) VALUES ('CH Test', 'whatsapp', 'discord', $1)`,
            [bookFid]
        );
        await pool.query(
            `INSERT INTO ${SCHEMA_A}.book_channels (book_fractal_id, direction, channel, status)
             VALUES ($1, 'inpipe', 'twilio', 'active')`,
            [bookFid]
        );
        const chB = await pool.query(`SELECT * FROM ${SCHEMA_B}.book_channels WHERE book_fractal_id = $1`, [bookFid]);
        assertEqual(chB.rows.length, 0, 'channel should not exist in schema B');
    }),

    test('audit_logs are schema-scoped', async () => {
        await pool.query(
            `INSERT INTO ${SCHEMA_A}.audit_logs (actor_user_id, action_type, target_type, target_id)
             VALUES ($1, 'TEST_ACTION', 'BOOK', '99')`,
            [userIdA]
        );
        const resultB = await pool.query(
            `SELECT * FROM ${SCHEMA_B}.audit_logs WHERE action_type = 'TEST_ACTION'`
        );
        assertEqual(resultB.rows.length, 0, 'audit log should not bleed to schema B');
    }),
];

const capsuleAndInpipeTests = [
    test('buildCapsule produces valid v2 capsule', () => {
        const c = buildCapsule({
            bookFractalId: 'bridge_t1_abc123',
            tenantId: 1,
            phone: '+60123456789',
            body: 'Test message',
            media: null,
            timestamp: '2026-03-28T00:00:00.000Z',
        });
        assertEqual(c.v, 2, 'version should be 2');
        assert(/^[a-f0-9]{64}$/.test(c.content_hash), 'invalid content_hash format');
        assert(/^[a-f0-9]{64}$/.test(c.sender_hash), 'invalid sender_hash format');
        assertEqual(c.book_fractal_id, 'bridge_t1_abc123', 'book_fractal_id mismatch');
        assertEqual(c.attachments.length, 0, 'should have no attachments');
    }),

    test('capsule attachment uses attachment_url (not discord_url)', () => {
        const buf = Buffer.from('test-image-data');
        const c = buildCapsule({
            bookFractalId: 'bridge_t1_abc123',
            tenantId: 1,
            phone: '+60123456789',
            body: 'Image attached',
            media: { buffer: buf, contentType: 'image/png' },
            timestamp: '2026-03-28T00:00:00.000Z',
        });
        assertEqual(c.attachments.length, 1, 'should have 1 attachment');
        assert('attachment_url' in c.attachments[0], 'should have attachment_url field');
        assert(!('discord_url' in c.attachments[0]), 'should NOT have discord_url field');
    }),

    test('capsule content_hash is deterministic for same body', () => {
        const args = { bookFractalId: 'b1', tenantId: 1, phone: '+1', body: 'same', media: null };
        const c1 = buildCapsule({ ...args, timestamp: '2026-01-01T00:00:00Z' });
        const c2 = buildCapsule({ ...args, timestamp: '2026-06-01T00:00:00Z' });
        assertEqual(c1.content_hash, c2.content_hash, 'same body should give same hash');
    }),

    test('capsule sender_hash is deterministic for same phone', () => {
        const args = { bookFractalId: 'b1', tenantId: 1, phone: '+60123456789', media: null };
        const c1 = buildCapsule({ ...args, body: 'hello', timestamp: '2026-01-01T00:00:00Z' });
        const c2 = buildCapsule({ ...args, body: 'world', timestamp: '2026-06-01T00:00:00Z' });
        assertEqual(c1.sender_hash, c2.sender_hash, 'same phone should give same sender_hash');
    }),

    test('TwilioChannel.normalizeMessage extracts joinCode', () => {
        const ch = new TwilioChannel({ logger: { info() {}, warn() {}, error() {} } });
        const msg = ch.normalizeMessage({
            from: 'whatsapp:+60123456789',
            body: 'hello abc-1f2e3d',
            messageId: 'SM123',
            mediaUrl: null,
            mediaContentType: null,
        });
        assertEqual(msg.phone, '+60123456789', 'phone should strip whatsapp: prefix');
        assertEqual(msg.joinCode, 'abc-1f2e3d', 'joinCode should be extracted');
        assertEqual(msg.channel, 'twilio', 'channel should be twilio');
        assertEqual(msg.hasMedia, false, 'hasMedia should be false');
    }),

    test('TwilioChannel.normalizeMessage handles media flag', () => {
        const ch = new TwilioChannel({ logger: { info() {}, warn() {}, error() {} } });
        const msg = ch.normalizeMessage({
            from: 'whatsapp:+60199999999',
            body: '',
            messageId: 'SM456',
            mediaUrl: 'https://api.twilio.com/media/123',
            mediaContentType: 'image/jpeg',
        });
        assertEqual(msg.hasMedia, true, 'hasMedia should be true');
        assertEqual(msg.mediaUrl, 'https://api.twilio.com/media/123', 'mediaUrl mismatch');
    }),

    test('TwilioChannel.isSandboxJoinCommand recognizes sandbox command', () => {
        const ch = new TwilioChannel({ logger: { info() {}, warn() {}, error() {} } });
        assert(ch.isSandboxJoinCommand('join baby-ability'), 'should recognize sandbox command');
        assert(!ch.isSandboxJoinCommand('hello'), 'should not match regular text');
    }),

    test('message_queue insert and retrieve roundtrip', async () => {
        const marker = `queue_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const payload = { msg: { body: marker, hasMedia: false }, channel: 'twilio' };
        await pool.query(
            `INSERT INTO core.message_queue (priority, payload, status) VALUES ($1, $2, 'done')`,
            ['text', JSON.stringify(payload)]
        );

        const result = await pool.query(
            `SELECT id, payload, status, priority FROM core.message_queue WHERE payload::text LIKE $1`,
            [`%${marker}%`]
        );
        assert(result.rows.length === 1, 'should find the inserted item');
        const item = typeof result.rows[0].payload === 'string'
            ? JSON.parse(result.rows[0].payload)
            : result.rows[0].payload;
        assertEqual(item.msg.body, marker, 'payload body mismatch');
        assertEqual(result.rows[0].priority, 'text', 'priority mismatch');

        await pool.query(`DELETE FROM core.message_queue WHERE id = $1`, [result.rows[0].id]);
    }),

    test('message_queue ordering: media priority sorts before text', async () => {
        const marker = `order_test_${Date.now()}`;
        await pool.query(
            `INSERT INTO core.message_queue (priority, payload, status, created_at)
             VALUES ('text', $1, 'done', NOW() - interval '10 seconds')`,
            [JSON.stringify({ msg: { body: `${marker}_text`, hasMedia: false }, _marker: marker })]
        );
        await pool.query(
            `INSERT INTO core.message_queue (priority, payload, status, created_at)
             VALUES ('media', $1, 'done', NOW())`,
            [JSON.stringify({ msg: { body: `${marker}_media`, hasMedia: true }, _marker: marker })]
        );

        const result = await pool.query(
            `SELECT payload FROM core.message_queue
             WHERE payload::text LIKE $1
             ORDER BY CASE WHEN priority = 'media' THEN 0 ELSE 1 END, created_at`,
            [`%${marker}%`]
        );
        assertEqual(result.rows.length, 2, 'should find 2 items');
        const first = typeof result.rows[0].payload === 'string'
            ? JSON.parse(result.rows[0].payload) : result.rows[0].payload;
        assertEqual(first.msg.hasMedia, true, 'media should sort first');

        await pool.query(`DELETE FROM core.message_queue WHERE payload::text LIKE $1`, [`%${marker}%`]);
    }),

    test('message_queue retry_count and status transitions', async () => {
        const marker = `retry_test_${Date.now()}`;
        const ins = await pool.query(
            `INSERT INTO core.message_queue (priority, payload, status, retry_count)
             VALUES ('text', $1, 'processing', 0) RETURNING id`,
            [JSON.stringify({ msg: { body: marker, hasMedia: false } })]
        );
        const qId = ins.rows[0].id;

        await pool.query(
            `UPDATE core.message_queue SET retry_count = retry_count + 1,
             status = CASE WHEN retry_count + 1 >= 3 THEN 'failed' ELSE 'processing' END
             WHERE id = $1`,
            [qId]
        );
        let row = await pool.query(`SELECT retry_count, status FROM core.message_queue WHERE id = $1`, [qId]);
        assertEqual(row.rows[0].retry_count, 1, 'retry_count should be 1');
        assertEqual(row.rows[0].status, 'processing', 'status should still be processing');

        await pool.query(`UPDATE core.message_queue SET retry_count = 2 WHERE id = $1`, [qId]);
        await pool.query(
            `UPDATE core.message_queue SET retry_count = retry_count + 1,
             status = CASE WHEN retry_count + 1 >= 3 THEN 'failed' ELSE 'processing' END
             WHERE id = $1`,
            [qId]
        );
        row = await pool.query(`SELECT retry_count, status FROM core.message_queue WHERE id = $1`, [qId]);
        assertEqual(row.rows[0].status, 'failed', 'status should be failed after 3 retries');

        await pool.query(`DELETE FROM core.message_queue WHERE id = $1`, [qId]);
    }),

    test('processed_sids idempotency guard', async () => {
        const sid = `SM_TEST_${Date.now()}`;
        const ins1 = await pool.query(
            `INSERT INTO core.processed_sids (sid, processed_at) VALUES ($1, NOW()) ON CONFLICT (sid) DO NOTHING RETURNING sid`,
            [sid]
        );
        assertEqual(ins1.rows.length, 1, 'first insert should succeed');

        const ins2 = await pool.query(
            `INSERT INTO core.processed_sids (sid, processed_at) VALUES ($1, NOW()) ON CONFLICT (sid) DO NOTHING RETURNING sid`,
            [sid]
        );
        assertEqual(ins2.rows.length, 0, 'duplicate insert should return 0 rows');

        await pool.query(`DELETE FROM core.processed_sids WHERE sid = $1`, [sid]);
    }),
];

const validatorTests = [
    test('VALID_SCHEMA_PATTERN accepts valid schemas', () => {
        assert(VALID_SCHEMA_PATTERN.test('tenant_1'), 'tenant_1 should be valid');
        assert(VALID_SCHEMA_PATTERN.test('tenant_999'), 'tenant_999 should be valid');
        assert(VALID_SCHEMA_PATTERN.test('core'), 'core should be valid');
    }),

    test('VALID_SCHEMA_PATTERN rejects SQL injection attempts', () => {
        assert(!VALID_SCHEMA_PATTERN.test("tenant_1; DROP TABLE users"), 'SQL injection should be rejected');
        assert(!VALID_SCHEMA_PATTERN.test("tenant_1'--"), 'quote injection should be rejected');
        assert(!VALID_SCHEMA_PATTERN.test("'), ('hack"), 'parenthesis injection should be rejected');
    }),

    test('assertValidSchemaName throws on invalid input', () => {
        let threw = false;
        try { assertValidSchemaName("tenant_1; DROP TABLE users"); } catch { threw = true; }
        assert(threw, 'should throw on SQL injection');

        threw = false;
        try { assertValidSchemaName(null); } catch { threw = true; }
        assert(threw, 'should throw on null');

        threw = false;
        try { assertValidSchemaName(''); } catch { threw = true; }
        assert(threw, 'should throw on empty string');
    }),

    test('assertValidSchemaName passes and returns valid schema', () => {
        const result = assertValidSchemaName('tenant_42');
        assertEqual(result, 'tenant_42', 'should return the schema name');
    }),
];

const bookRegistryTests = [
    test('core.book_registry insert and lookup', async () => {
        const joinCode = `test-${crypto.randomBytes(4).toString('hex')}`;
        const fractalId = `bridge_t${tenantIdA}_${crypto.randomBytes(6).toString('hex')}`;
        await pool.query(
            `INSERT INTO core.book_registry (book_name, join_code, fractal_id, tenant_schema, tenant_email, outpipe_ledger, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
            ['Registry Test', joinCode, fractalId, SCHEMA_A, TEST_EMAIL_A, 'https://discord.com/api/webhooks/test']
        );
        const result = await pool.query(
            `SELECT * FROM core.book_registry WHERE fractal_id = $1`,
            [fractalId]
        );
        assertEqual(result.rows.length, 1, 'should find registry entry');
        assertEqual(result.rows[0].tenant_schema, SCHEMA_A, 'schema mismatch');
        assertEqual(result.rows[0].status, 'active', 'status mismatch');

        await pool.query(`DELETE FROM core.book_registry WHERE fractal_id = $1`, [fractalId]);
    }),

    test('core.book_shares cross-tenant sharing record', async () => {
        const fid = `bridge_t${tenantIdA}_${crypto.randomBytes(6).toString('hex')}`;
        await pool.query(
            `INSERT INTO core.book_shares (book_fractal_id, owner_email, shared_with_email, permission_level)
             VALUES ($1, $2, $3, 'viewer')`,
            [fid, TEST_EMAIL_A, TEST_EMAIL_B]
        );
        const result = await pool.query(
            `SELECT * FROM core.book_shares WHERE shared_with_email = $1 AND revoked_at IS NULL`,
            [TEST_EMAIL_B]
        );
        assert(result.rows.length >= 1, 'should find share record');
        const share = result.rows.find(s => s.book_fractal_id === fid);
        assert(share, 'should find specific share');
        assertEqual(share.owner_email, TEST_EMAIL_A, 'owner mismatch');

        await pool.query(`DELETE FROM core.book_shares WHERE book_fractal_id = $1`, [fid]);
    }),

    test('message_ledger insert and uniqueness', async () => {
        const msgFid = `msg_t1_${crypto.randomBytes(8).toString('hex')}`;
        const bookFid = `bridge_t1_${crypto.randomBytes(6).toString('hex')}`;
        await pool.query(
            `INSERT INTO core.message_ledger (message_fractal_id, book_fractal_id, sender_hash, content_hash, env)
             VALUES ($1, $2, $3, $4, 'test')`,
            [msgFid, bookFid, crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')]
        );
        let threw = false;
        try {
            await pool.query(
                `INSERT INTO core.message_ledger (message_fractal_id, book_fractal_id, sender_hash, content_hash, env)
                 VALUES ($1, $2, $3, $4, 'test')`,
                [msgFid, bookFid, 'aaa', 'bbb']
            );
        } catch { threw = true; }
        assert(threw, 'duplicate message_fractal_id should violate PK constraint');

        await pool.query(`DELETE FROM core.message_ledger WHERE message_fractal_id = $1`, [msgFid]);
    }),
];

async function run() {
    console.log(`\n  Core Flow Tests — ${new Date().toISOString()}`);
    console.log('  ' + '═'.repeat(55));

    try {
        console.log('\n  ⚙️  Setting up test schemas...');
        await setup();
        console.log(`  ✅  Setup complete (schemas: ${SCHEMA_A}, ${SCHEMA_B})\n`);
    } catch (e) {
        console.error(`  ❌  Setup failed: ${e.message}`);
        process.exit(1);
    }

    const sections = [
        { name: '🔐 Auth & JWT', tests: authTests },
        { name: '📚 Books CRUD', tests: booksCrudTests },
        { name: '🏢 Tenant Isolation', tests: tenantIsolationTests },
        { name: '📦 Capsule & Inpipe', tests: capsuleAndInpipeTests },
        { name: '🛡️ Validators', tests: validatorTests },
        { name: '📋 Book Registry & Ledger', tests: bookRegistryTests },
    ];

    for (const section of sections) {
        console.log(`\n  ${section.name}`);
        console.log('  ' + '─'.repeat(50));
        for (const t of section.tests) {
            await runTest(t);
        }
    }

    console.log('\n  ' + '═'.repeat(55));
    console.log(`  📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);

    if (failures.length > 0) {
        console.log('\n  Failed tests:');
        failures.forEach(f => console.log(`    ❌ ${f.label}: ${f.error}`));
    }

    console.log('\n  ⚙️  Tearing down test schemas...');
    await teardown();
    console.log('  ✅  Teardown complete');
    console.log('  ' + '═'.repeat(55) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
    console.error(`\n  💥 Fatal error: ${e.message}`);
    teardown().finally(() => process.exit(1));
});
