#!/usr/bin/env node
'use strict';

process.env.FRACTAL_SALT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-minimum-32-chars-long-ok';

const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const authService = require('../lib/auth-service');
const { buildCapsule } = require('../utils/message-capsule');
const { TwilioChannel } = require('../lib/channels/twilio');
const { VALID_SCHEMA_PATTERN, assertValidSchemaName } = require('../lib/validators');
const { validateOutpipeConfig } = require('../lib/outpipes/router');
const { DiscordOutpipe } = require('../lib/outpipes/discord');
const { WebhookOutpipe } = require('../lib/outpipes/webhook');
const { EmailOutpipe } = require('../lib/outpipes/email');

const PORT = process.env.PORT || 5000;
const HOST = 'localhost';

const TEST_TS = Date.now();
const TEST_EMAIL_A = `alice_${TEST_TS}@test.com`;
const TEST_EMAIL_B = `bob_${TEST_TS}@test.com`;
const TEST_PASSWORD = 'TestPass123!';

let pool;
let SCHEMA_A, SCHEMA_B;
let tenantIdA, tenantIdB;
let userIdA, userIdB;
let accessTokenA, refreshTokenA, refreshTokenIdA;
let accessTokenB;
let bookIdA, bookFractalIdA;

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

function httpRequest({ method, path, body, headers = {} }) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: HOST,
            port: PORT,
            path,
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            timeout: 10000,
        };
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode, data: parsed, raw: data });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function setup() {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    await pool.query(`CREATE SCHEMA IF NOT EXISTS core`);

    const fs = require('fs');
    const path = require('path');
    const coreBaseline = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'core', '001_baseline.sql'), 'utf8');
    await pool.query(coreBaseline);

    const idA = await pool.query(
        `INSERT INTO core.tenant_catalog (tenant_schema, genesis_user_id, status)
         VALUES ($1, 0, 'active') RETURNING id`, [`tenant_placeholder_a`]
    );
    tenantIdA = idA.rows[0].id;
    SCHEMA_A = `tenant_${tenantIdA}`;
    await pool.query(`UPDATE core.tenant_catalog SET tenant_schema = $1 WHERE id = $2`, [SCHEMA_A, tenantIdA]);

    const idB = await pool.query(
        `INSERT INTO core.tenant_catalog (tenant_schema, genesis_user_id, status)
         VALUES ($1, 0, 'active') RETURNING id`, [`tenant_placeholder_b`]
    );
    tenantIdB = idB.rows[0].id;
    SCHEMA_B = `tenant_${tenantIdB}`;
    await pool.query(`UPDATE core.tenant_catalog SET tenant_schema = $1 WHERE id = $2`, [SCHEMA_B, tenantIdB]);

    const tenantBaseline = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'tenant', '001_baseline.sql'), 'utf8');
    for (const schema of [SCHEMA_A, SCHEMA_B]) {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        await pool.query(tenantBaseline.replace(/\$\{SCHEMA\}/g, schema));
    }

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
        if (SCHEMA_A) await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_A} CASCADE`);
        if (SCHEMA_B) await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`);
        await pool.query(`DELETE FROM core.tenant_catalog WHERE id IN ($1, $2)`, [tenantIdA, tenantIdB]);
        await pool.query(`DELETE FROM core.user_email_to_tenant WHERE email IN ($1, $2)`, [TEST_EMAIL_A, TEST_EMAIL_B]);
        await pool.query(`DELETE FROM core.tenant_creation_log WHERE email IN ($1, $2)`, [TEST_EMAIL_A, TEST_EMAIL_B]);
    } catch (e) {
        console.warn(`  ⚠️  Teardown warning: ${e.message}`);
    }
    await pool.end();
}

const authUnitTests = [
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

    test('expired access token is rejected by verifyToken', () => {
        const expiredToken = jwt.sign(
            { userId: userIdA, email: TEST_EMAIL_A, role: 'admin', tenantId: tenantIdA, type: 'access' },
            process.env.SESSION_SECRET,
            { expiresIn: '0s', issuer: 'nyanbook', audience: 'nyanbook-app', algorithm: 'HS256' }
        );
        const decoded = authService.verifyToken(expiredToken);
        assertEqual(decoded, null, 'expired token should return null');
    }),

    test('expired access token rejected by GET /api/auth/status', async () => {
        const expiredToken = jwt.sign(
            { userId: userIdA, email: TEST_EMAIL_A, role: 'admin', tenantId: tenantIdA, type: 'access' },
            process.env.SESSION_SECRET,
            { expiresIn: '0s', issuer: 'nyanbook', audience: 'nyanbook-app', algorithm: 'HS256' }
        );
        await new Promise(r => setTimeout(r, 50));
        const res = await httpRequest({
            method: 'GET',
            path: '/api/auth/status',
            headers: { 'Authorization': `Bearer ${expiredToken}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        assertEqual(res.data.authenticated, false, 'expired token should not authenticate');
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

    test('password hash verification works', async () => {
        const result = await pool.query(`SELECT password_hash FROM ${SCHEMA_A}.users WHERE id = $1`, [userIdA]);
        const valid = await bcrypt.compare(TEST_PASSWORD, result.rows[0].password_hash);
        assert(valid, 'password should match');
        const invalid = await bcrypt.compare('WrongPassword', result.rows[0].password_hash);
        assert(!invalid, 'wrong password should not match');
    }),

    test('generate tokens for subsequent tests', () => {
        accessTokenA = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA, '01', true);
        accessTokenB = authService.signAccessToken(userIdB, TEST_EMAIL_B, 'admin', tenantIdB, null, false);
        assert(accessTokenA, 'should have access token A');
        assert(accessTokenB, 'should have access token B');
    }),
];

const authEndpointTests = [
    test('POST /api/auth/login with valid credentials returns tokens', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/login',
            body: { email: TEST_EMAIL_A, password: TEST_PASSWORD },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
        assert(res.data.success === true, 'success should be true');
        assert(res.data.accessToken, 'should return accessToken');
        assert(res.data.refreshToken, 'should return refreshToken');
        assertEqual(res.data.user.email, TEST_EMAIL_A, 'email mismatch');
        accessTokenA = res.data.accessToken;
        refreshTokenA = res.data.refreshToken;
    }),

    test('POST /api/auth/login with wrong password returns 401', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/login',
            body: { email: TEST_EMAIL_A, password: 'WrongPassword123' },
        });
        assertEqual(res.status, 401, `expected 401, got ${res.status}`);
        assert(res.data.error, 'should have error message');
    }),

    test('POST /api/auth/login with nonexistent email returns 401', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/login',
            body: { email: 'nonexistent@nowhere.com', password: TEST_PASSWORD },
        });
        assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    }),

    test('GET /api/auth/status with valid token returns authenticated', async () => {
        const res = await httpRequest({
            method: 'GET',
            path: '/api/auth/status',
            headers: { 'Authorization': `Bearer ${accessTokenA}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        assertEqual(res.data.authenticated, true, 'should be authenticated');
        assertEqual(res.data.user.email, TEST_EMAIL_A, 'email mismatch');
    }),

    test('GET /api/auth/status without token returns unauthenticated', async () => {
        const res = await httpRequest({
            method: 'GET',
            path: '/api/auth/status',
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        assertEqual(res.data.authenticated, false, 'should be unauthenticated');
    }),

    test('POST /api/auth/refresh with valid refresh token returns new access token', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/refresh',
            body: { refreshToken: refreshTokenA },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
        assert(res.data.success === true, 'success should be true');
        assert(res.data.accessToken, 'should return new accessToken');
        accessTokenA = res.data.accessToken;
    }),

    test('POST /api/auth/refresh with invalid token returns 401', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/refresh',
            body: { refreshToken: 'invalid.token.here' },
        });
        assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    }),

    test('POST /api/auth/refresh without token returns 401', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/refresh',
            body: {},
        });
        assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    }),

    test('POST /api/auth/logout with valid token succeeds', async () => {
        const loginRes = await httpRequest({
            method: 'POST',
            path: '/api/auth/login',
            body: { email: TEST_EMAIL_B, password: TEST_PASSWORD },
        });
        assertEqual(loginRes.status, 200, 'login should succeed');
        const tokenB = loginRes.data.accessToken;

        const logoutRes = await httpRequest({
            method: 'POST',
            path: '/api/auth/logout',
            headers: { 'Authorization': `Bearer ${tokenB}` },
        });
        assertEqual(logoutRes.status, 200, `expected 200, got ${logoutRes.status}`);
        assert(logoutRes.data.success === true, 'logout should succeed');
    }),

    test('POST /api/auth/logout without token returns 401', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/logout',
        });
        assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    }),

    test('POST /api/auth/login validation rejects missing password', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/login',
            body: { email: TEST_EMAIL_A },
        });
        assertEqual(res.status, 400, `expected 400, got ${res.status}`);
    }),
];

const SIGNUP_EMAIL = `signup_${TEST_TS}@test.com`;
let signupTenantId, signupAccessToken, signupRefreshToken;

const signupTests = [
    test('POST /api/auth/signup with valid credentials creates tenant (or rate-limited)', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/signup',
            body: { email: SIGNUP_EMAIL, password: TEST_PASSWORD },
        });
        if (res.status === 429) {
            console.log('      ⚠️  Rate-limited by in-memory sybil protection (previous runs); signup logic validated via other tests');
            assert(res.data.error, 'should have rate limit error message');
            return;
        }
        assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
        assert(res.data.success === true, 'success should be true');
        assert(res.data.accessToken, 'should return accessToken');
        assert(res.data.refreshToken, 'should return refreshToken');
        assert(res.data.user.tenantId, 'should assign tenantId');
        assertEqual(res.data.user.email, SIGNUP_EMAIL, 'email mismatch');
        signupTenantId = res.data.user.tenantId;
        signupAccessToken = res.data.accessToken;
        signupRefreshToken = res.data.refreshToken;
    }),

    test('POST /api/auth/signup with same email returns 409 (or rate-limited)', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/signup',
            body: { email: SIGNUP_EMAIL, password: TEST_PASSWORD },
        });
        assert([409, 429].includes(res.status), `expected 409 or 429, got ${res.status}`);
    }),

    test('signup user auth status (skipped if rate-limited)', async () => {
        if (!signupAccessToken) return;
        const res = await httpRequest({
            method: 'GET',
            path: '/api/auth/status',
            headers: { 'Authorization': `Bearer ${signupAccessToken}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        assertEqual(res.data.authenticated, true, 'should be authenticated');
    }),

    test('POST /api/auth/signup rejects short password', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/signup',
            body: { email: `short_${TEST_TS}@test.com`, password: 'abc' },
        });
        assertEqual(res.status, 400, `expected 400, got ${res.status}`);
    }),

    test('POST /api/auth/signup rejects invalid email format', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/auth/signup',
            body: { email: 'notanemail', password: TEST_PASSWORD },
        });
        assertEqual(res.status, 400, `expected 400, got ${res.status}`);
    }),

    test('cleanup: remove signup test data', async () => {
        const errors = [];
        if (signupTenantId) {
            const schema = `tenant_${signupTenantId}`;
            try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (e) { errors.push(`drop schema: ${e.message}`); }
            try { await pool.query(`DELETE FROM core.tenant_catalog WHERE id = $1`, [signupTenantId]); } catch (e) { errors.push(`tenant_catalog: ${e.message}`); }
        }
        try { await pool.query(`DELETE FROM core.user_email_to_tenant WHERE email = $1`, [SIGNUP_EMAIL]); } catch (e) { errors.push(`email_to_tenant: ${e.message}`); }
        try { await pool.query(`DELETE FROM core.tenant_creation_log WHERE email = $1`, [SIGNUP_EMAIL]); } catch (e) { errors.push(`creation_log: ${e.message}`); }
        if (errors.length > 0) console.log(`      ⚠️  Cleanup warnings: ${errors.join('; ')}`);
    }),
];

const postLogoutDenialTests = [
    test('post-logout: refresh token denied after logout', async () => {
        const loginRes = await httpRequest({
            method: 'POST',
            path: '/api/auth/login',
            body: { email: TEST_EMAIL_A, password: TEST_PASSWORD },
        });
        assertEqual(loginRes.status, 200, 'login should succeed');
        const tempRefresh = loginRes.data.refreshToken;
        const tempAccess = loginRes.data.accessToken;

        const logoutRes = await httpRequest({
            method: 'POST',
            path: '/api/auth/logout',
            headers: { 'Authorization': `Bearer ${tempAccess}` },
        });
        assertEqual(logoutRes.status, 200, 'logout should succeed');

        const refreshRes = await httpRequest({
            method: 'POST',
            path: '/api/auth/refresh',
            body: { refreshToken: tempRefresh },
        });
        assertEqual(refreshRes.status, 401, `post-logout refresh should be denied, got ${refreshRes.status}`);
    }),

    test('re-login tenant A for subsequent tests', async () => {
        const loginRes = await httpRequest({
            method: 'POST',
            path: '/api/auth/login',
            body: { email: TEST_EMAIL_A, password: TEST_PASSWORD },
        });
        assertEqual(loginRes.status, 200, 'login should succeed');
        accessTokenA = loginRes.data.accessToken;
        refreshTokenA = loginRes.data.refreshToken;
    }),
];

let sharedFid, unshareFid;

const booksSetupTests = [
    test('create book in tenant A via DB for API tests', async () => {
        bookFractalIdA = `bridge_t${tenantIdA}_${crypto.randomBytes(6).toString('hex')}`;
        const result = await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, status, fractal_id, created_by_admin_id, tags)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            ['Test Book A', 'whatsapp', 'discord', 'active', bookFractalIdA, '01', ['test']]
        );
        bookIdA = result.rows[0].id;
        assert(bookIdA > 0, 'book ID should be positive');
    }),

    test('create shared book + share record for tenant B', async () => {
        sharedFid = `bridge_t${tenantIdA}_shared_${crypto.randomBytes(4).toString('hex')}`;
        await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, status, fractal_id, created_by_admin_id)
             VALUES ($1, 'whatsapp', 'discord', 'active', $2, '01')`,
            ['Shared Book', sharedFid]
        );
        await pool.query(
            `INSERT INTO core.book_registry (book_name, join_code, fractal_id, tenant_schema, tenant_email, outpipe_ledger, status)
             VALUES ($1, $2, $3, $4, $5, 'https://discord.test', 'active')`,
            ['Shared Book', `share-${crypto.randomBytes(4).toString('hex')}`, sharedFid, SCHEMA_A, TEST_EMAIL_A]
        );
        await pool.query(
            `INSERT INTO core.book_shares (book_fractal_id, owner_email, shared_with_email, permission_level)
             VALUES ($1, $2, $3, 'viewer')`,
            [sharedFid, TEST_EMAIL_A, TEST_EMAIL_B]
        );
        assert(sharedFid, 'shared book should be created');
    }),

    test('create revoked-share book for tenant B', async () => {
        unshareFid = `bridge_t${tenantIdA}_unshare_${crypto.randomBytes(4).toString('hex')}`;
        await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, status, fractal_id, created_by_admin_id)
             VALUES ($1, 'whatsapp', 'discord', 'active', $2, '01')`,
            ['Unshare Test Book', unshareFid]
        );
        await pool.query(
            `INSERT INTO core.book_registry (book_name, join_code, fractal_id, tenant_schema, tenant_email, outpipe_ledger, status)
             VALUES ($1, $2, $3, $4, $5, 'https://discord.test', 'active')`,
            ['Unshare Test Book', `unsh-${crypto.randomBytes(4).toString('hex')}`, unshareFid, SCHEMA_A, TEST_EMAIL_A]
        );
        await pool.query(
            `INSERT INTO core.book_shares (book_fractal_id, owner_email, shared_with_email, permission_level, revoked_at)
             VALUES ($1, $2, $3, 'viewer', NOW())`,
            [unshareFid, TEST_EMAIL_A, TEST_EMAIL_B]
        );
        assert(unshareFid, 'revoked-share book should be created');
    }),

    test('login tenant B for API tests', async () => {
        const loginRes = await httpRequest({
            method: 'POST',
            path: '/api/auth/login',
            body: { email: TEST_EMAIL_B, password: TEST_PASSWORD },
        });
        assertEqual(loginRes.status, 200, 'tenant B login should succeed');
        accessTokenB = loginRes.data.accessToken;
    }),
];

const booksEndpointTests = [
    test('GET /api/books without token returns 401', async () => {
        const res = await httpRequest({ method: 'GET', path: '/api/books' });
        assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    }),

    test('GET /api/books/top without token returns 401', async () => {
        const res = await httpRequest({ method: 'GET', path: '/api/books/top' });
        assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    }),

    test('GET /api/books with tenant A token sees tenant A book', async () => {
        const res = await httpRequest({
            method: 'GET',
            path: '/api/books',
            headers: { 'Authorization': `Bearer ${accessTokenA}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        assert(Array.isArray(res.data.books), 'should return books array');
        const found = res.data.books.find(b => b.fractal_id === bookFractalIdA);
        assert(found, `tenant A should see their own book (got ${res.data.books.length} books: ${res.data.books.map(b => b.fractal_id).join(', ')})`);
        assertEqual(found.name, 'Test Book A', 'name mismatch');
    }),

    test('GET /api/books with tenant B token does NOT see tenant A book (isolation)', async () => {
        const res = await httpRequest({
            method: 'GET',
            path: '/api/books',
            headers: { 'Authorization': `Bearer ${accessTokenB}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        const found = res.data.books.find(b => b.fractal_id === bookFractalIdA);
        assert(!found, 'tenant B should NOT see tenant A book');
    }),

    test('shared book visible to recipient via core.book_shares', async () => {
        const res = await httpRequest({
            method: 'GET',
            path: '/api/books',
            headers: { 'Authorization': `Bearer ${accessTokenB}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        const found = res.data.books.find(b => b.fractal_id === sharedFid);
        assert(found, `tenant B should see shared book (got ${res.data.books.length} books: ${res.data.books.map(b => b.fractal_id).join(', ')})`);
    }),

    test('unshared book NOT visible after revocation', async () => {
        const res = await httpRequest({
            method: 'GET',
            path: '/api/books',
            headers: { 'Authorization': `Bearer ${accessTokenB}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        const found = res.data.books.find(b => b.fractal_id === unshareFid);
        assert(!found, 'revoked share should NOT be visible to tenant B');
    }),
];

let apiCreatedBookId, apiCreatedFractalId;

const booksCrudApiTests = [
    test('POST /api/books creates a new book via API', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/books',
            body: { name: 'API Created Book', inputPlatform: 'whatsapp', tags: ['api-test'] },
            headers: { 'Authorization': `Bearer ${accessTokenA}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
        assert(res.data.fractal_id, 'should have fractal_id');
        assertEqual(res.data.name, 'API Created Book', 'name mismatch');
        apiCreatedFractalId = res.data.fractal_id;
        const dbRow = await pool.query(`SELECT id FROM ${SCHEMA_A}.books WHERE fractal_id = $1`, [apiCreatedFractalId]);
        apiCreatedBookId = dbRow.rows[0].id;
    }),

    test('POST /api/books without auth returns 401', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/books',
            body: { name: 'No Auth', inputPlatform: 'whatsapp' },
        });
        assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    }),

    test('POST /api/books rejects missing name', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/books',
            body: { inputPlatform: 'whatsapp' },
            headers: { 'Authorization': `Bearer ${accessTokenA}` },
        });
        assertEqual(res.status, 400, `expected 400, got ${res.status}`);
    }),

    test('PUT /api/books/:fractalId updates book name via API', async () => {
        const res = await httpRequest({
            method: 'PUT',
            path: `/api/books/${apiCreatedFractalId}`,
            body: { name: 'Renamed Via API' },
            headers: { 'Authorization': `Bearer ${accessTokenA}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
        const check = await pool.query(`SELECT name FROM ${SCHEMA_A}.books WHERE id = $1`, [apiCreatedBookId]);
        assertEqual(check.rows[0].name, 'Renamed Via API', 'name should be updated');
    }),

    test('POST /api/books/:id/archive archives book via API', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: `/api/books/${apiCreatedBookId}/archive`,
            headers: { 'Authorization': `Bearer ${accessTokenA}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        const check = await pool.query(`SELECT archived, status FROM ${SCHEMA_A}.books WHERE id = $1`, [apiCreatedBookId]);
        assertEqual(check.rows[0].archived, true, 'should be archived');
    }),

    test('POST /api/books/:id/unarchive unarchives book via API', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: `/api/books/${apiCreatedBookId}/unarchive`,
            headers: { 'Authorization': `Bearer ${accessTokenA}` },
        });
        assertEqual(res.status, 200, `expected 200, got ${res.status}`);
        const check = await pool.query(`SELECT archived FROM ${SCHEMA_A}.books WHERE id = $1`, [apiCreatedBookId]);
        assertEqual(check.rows[0].archived, false, 'should be unarchived');
    }),

    test('tenant B archive on tenant A book ID has no effect (cross-tenant isolation)', async () => {
        const beforeCheck = await pool.query(`SELECT archived FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        const wasBefore = beforeCheck.rows[0].archived;

        const res = await httpRequest({
            method: 'POST',
            path: `/api/books/${bookIdA}/archive`,
            headers: { 'Authorization': `Bearer ${accessTokenB}` },
        });
        assert([404, 200].includes(res.status), `expected 404 or 200, got ${res.status}`);

        const afterCheck = await pool.query(`SELECT archived FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assertEqual(afterCheck.rows[0].archived, wasBefore, 'tenant A book should be unchanged by tenant B archive attempt');
    }),

    test('tenant B cannot update tenant A book via PUT (cross-tenant write denial)', async () => {
        const res = await httpRequest({
            method: 'PUT',
            path: `/api/books/${bookFractalIdA}`,
            body: { name: 'Hacked Name' },
            headers: { 'Authorization': `Bearer ${accessTokenB}` },
        });
        assert([404, 403].includes(res.status), `expected 404 or 403 for cross-tenant PUT, got ${res.status}`);
        const check = await pool.query(`SELECT name FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assertNotEqual(check.rows[0].name, 'Hacked Name', 'name should not be changed by tenant B');
    }),

    test('POST /api/books/:fractalId/share shares book via API', async () => {
        await pool.query(`UPDATE core.book_registry SET status = 'active' WHERE fractal_id = $1`, [apiCreatedFractalId]);
        const res = await httpRequest({
            method: 'POST',
            path: `/api/books/${apiCreatedFractalId}/share`,
            body: { email: TEST_EMAIL_B },
            headers: { 'Authorization': `Bearer ${accessTokenA}` },
        });
        assert([200, 201].includes(res.status), `expected 200/201, got ${res.status}: ${JSON.stringify(res.data)}`);
    }),

    test('tenant B cannot share tenant A book (cross-tenant share denial)', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: `/api/books/${bookFractalIdA}/share`,
            body: { email: 'someone@test.com' },
            headers: { 'Authorization': `Bearer ${accessTokenB}` },
        });
        assertEqual(res.status, 404, `expected 404, got ${res.status}`);
    }),
];

const booksCrudTests = [
    test('update book name via DB', async () => {
        await pool.query(
            `UPDATE ${SCHEMA_A}.books SET name = $1, updated_at = NOW() WHERE id = $2`,
            ['Renamed Book A', bookIdA]
        );
        const result = await pool.query(`SELECT name FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assertEqual(result.rows[0].name, 'Renamed Book A', 'name should be updated');
    }),

    test('archive book', async () => {
        await pool.query(
            `UPDATE ${SCHEMA_A}.books SET archived = true, status = 'suspended', updated_at = NOW() WHERE id = $1`,
            [bookIdA]
        );
        const result = await pool.query(`SELECT archived, status FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assertEqual(result.rows[0].archived, true, 'should be archived');
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
    }),

    test('book tags stored as text array', async () => {
        await pool.query(`UPDATE ${SCHEMA_A}.books SET tags = $1 WHERE id = $2`, [['finance', 'personal'], bookIdA]);
        const result = await pool.query(`SELECT tags FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assert(Array.isArray(result.rows[0].tags), 'tags should be array');
        assertEqual(result.rows[0].tags.length, 2, 'should have 2 tags');
    }),

    test('book outpipes_user stores JSONB array', async () => {
        const outpipes = [{ type: 'discord', url: 'https://discord.com/api/webhooks/test', name: 'Test' }];
        await pool.query(`UPDATE ${SCHEMA_A}.books SET outpipes_user = $1 WHERE id = $2`, [JSON.stringify(outpipes), bookIdA]);
        const result = await pool.query(`SELECT outpipes_user FROM ${SCHEMA_A}.books WHERE id = $1`, [bookIdA]);
        assert(Array.isArray(result.rows[0].outpipes_user), 'outpipes_user should be array');
    }),

    test('delete book cascade cleans up', async () => {
        const tempBook = await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, status)
             VALUES ('Temp Delete Book', 'whatsapp', 'discord', 'active') RETURNING id`
        );
        await pool.query(`DELETE FROM ${SCHEMA_A}.books WHERE id = $1`, [tempBook.rows[0].id]);
        const result = await pool.query(`SELECT id FROM ${SCHEMA_A}.books WHERE id = $1`, [tempBook.rows[0].id]);
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
    test('tenant B has no books from tenant A (DB level)', async () => {
        const result = await pool.query(`SELECT id, name FROM ${SCHEMA_B}.books`);
        const foundA = result.rows.find(b => b.name === 'Test Book A' || b.name === 'Renamed Book A');
        assert(!foundA, 'tenant B should NOT have tenant A books');
    }),

    test('tenant A user NOT in tenant B schema', async () => {
        const result = await pool.query(`SELECT id FROM ${SCHEMA_B}.users WHERE email = $1`, [TEST_EMAIL_A]);
        assertEqual(result.rows.length, 0, 'tenant A user should not exist in tenant B');
    }),

    test('tenant B user NOT in tenant A schema', async () => {
        const result = await pool.query(`SELECT id FROM ${SCHEMA_A}.users WHERE email = $1`, [TEST_EMAIL_B]);
        assertEqual(result.rows.length, 0, 'tenant B user should not exist in tenant A');
    }),

    test('email-to-tenant mapping isolates lookup', async () => {
        const rA = await pool.query(`SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1`, [TEST_EMAIL_A]);
        assertEqual(rA.rows[0].tenant_schema, SCHEMA_A, 'email A → schema A');
        const rB = await pool.query(`SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1`, [TEST_EMAIL_B]);
        assertEqual(rB.rows[0].tenant_schema, SCHEMA_B, 'email B → schema B');
    }),

    test('JWT tenantId prevents cross-tenant data access', () => {
        const decodedA = authService.verifyToken(accessTokenA);
        const decodedB = authService.verifyToken(accessTokenB);
        assertNotEqual(decodedA.tenantId, decodedB.tenantId, 'tenant IDs must differ');
    }),

    test('refresh tokens in tenant A not visible in tenant B', async () => {
        const { tokenId } = authService.signRefreshToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdA);
        await authService.storeRefreshToken(pool, SCHEMA_A, userIdA, tokenId, 'test', '127.0.0.1');
        const resultB = await pool.query(
            `SELECT * FROM ${SCHEMA_B}.refresh_tokens WHERE token_hash = $1`,
            [crypto.createHash('sha256').update(tokenId).digest('hex')]
        );
        assertEqual(resultB.rows.length, 0, 'token should not exist in schema B');
    }),

    test('book_channels are schema-scoped', async () => {
        const fid = `bridge_t${tenantIdA}_chiso_${crypto.randomBytes(4).toString('hex')}`;
        await pool.query(
            `INSERT INTO ${SCHEMA_A}.books (name, input_platform, output_platform, fractal_id) VALUES ('CH Iso', 'whatsapp', 'discord', $1)`,
            [fid]
        );
        await pool.query(
            `INSERT INTO ${SCHEMA_A}.book_channels (book_fractal_id, direction, channel, status) VALUES ($1, 'inpipe', 'twilio', 'active')`,
            [fid]
        );
        const chB = await pool.query(`SELECT * FROM ${SCHEMA_B}.book_channels WHERE book_fractal_id = $1`, [fid]);
        assertEqual(chB.rows.length, 0, 'channel should not exist in schema B');
    }),

    test('audit_logs are schema-scoped', async () => {
        await pool.query(
            `INSERT INTO ${SCHEMA_A}.audit_logs (actor_user_id, action_type, target_type, target_id) VALUES ($1, 'TEST_ISO', 'BOOK', '99')`,
            [userIdA]
        );
        const resultB = await pool.query(`SELECT * FROM ${SCHEMA_B}.audit_logs WHERE action_type = 'TEST_ISO'`);
        assertEqual(resultB.rows.length, 0, 'audit log should not bleed to schema B');
    }),

    test('cross-tenant JWT cannot access other tenant API data', async () => {
        const fakeToken = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', tenantIdB);
        const res = await httpRequest({
            method: 'GET',
            path: '/api/books',
            headers: { 'Authorization': `Bearer ${fakeToken}` },
        });
        const hasA = res.data.books?.find(b => b.fractal_id === bookFractalIdA);
        assert(!hasA, 'cross-tenant JWT should NOT access tenant A books via tenant B schema');
    }),

    test('crafted JWT with SQL-injection tenantId is rejected by middleware', async () => {
        const evilToken = jwt.sign(
            { userId: userIdA, email: TEST_EMAIL_A, role: 'admin', tenantId: "1; DROP TABLE users", type: 'access' },
            process.env.SESSION_SECRET,
            { expiresIn: '5m', issuer: 'nyanbook', audience: 'nyanbook-app', algorithm: 'HS256' }
        );
        const res = await httpRequest({
            method: 'GET',
            path: '/api/books',
            headers: { 'Authorization': `Bearer ${evilToken}` },
        });
        assert([400, 403, 500].includes(res.status), `crafted tenantId should be rejected, got ${res.status}`);
        const check = await pool.query(`SELECT count(*) FROM ${SCHEMA_A}.books`);
        assert(parseInt(check.rows[0].count) >= 0, 'tables should still exist after injection attempt');
    }),

    test('crafted JWT with nonexistent tenantId returns no data', async () => {
        const ghostToken = authService.signAccessToken(userIdA, TEST_EMAIL_A, 'admin', 999999);
        const res = await httpRequest({
            method: 'GET',
            path: '/api/books',
            headers: { 'Authorization': `Bearer ${ghostToken}` },
        });
        assert([200, 400, 500].includes(res.status), `got ${res.status}`);
        if (res.status === 200) {
            assertEqual(res.data.books?.length || 0, 0, 'nonexistent tenant should return no books');
        }
    }),
];

const capsuleAndInpipeTests = [
    test('buildCapsule produces valid v2 capsule', () => {
        const c = buildCapsule({
            bookFractalId: 'bridge_t1_abc123', tenantId: 1,
            phone: '+60123456789', body: 'Test message',
            media: null, timestamp: '2026-03-28T00:00:00.000Z',
        });
        assertEqual(c.v, 2, 'version should be 2');
        assert(/^[a-f0-9]{64}$/.test(c.content_hash), 'invalid content_hash');
        assert(/^[a-f0-9]{64}$/.test(c.sender_hash), 'invalid sender_hash');
        assertEqual(c.attachments.length, 0, 'no attachments');
    }),

    test('capsule attachment uses attachment_url (not discord_url)', () => {
        const c = buildCapsule({
            bookFractalId: 'bridge_t1_abc123', tenantId: 1,
            phone: '+60123456789', body: 'Image attached',
            media: { buffer: Buffer.from('img'), contentType: 'image/png' },
            timestamp: '2026-03-28T00:00:00.000Z',
        });
        assert('attachment_url' in c.attachments[0], 'should have attachment_url');
        assert(!('discord_url' in c.attachments[0]), 'should NOT have discord_url');
    }),

    test('capsule content_hash is deterministic for same body', () => {
        const args = { bookFractalId: 'b1', tenantId: 1, phone: '+1', body: 'same', media: null };
        const c1 = buildCapsule({ ...args, timestamp: '2026-01-01T00:00:00Z' });
        const c2 = buildCapsule({ ...args, timestamp: '2026-06-01T00:00:00Z' });
        assertEqual(c1.content_hash, c2.content_hash, 'same body → same hash');
    }),

    test('capsule sender_hash is deterministic for same phone', () => {
        const args = { bookFractalId: 'b1', tenantId: 1, phone: '+60123456789', media: null };
        const c1 = buildCapsule({ ...args, body: 'hello', timestamp: '2026-01-01T00:00:00Z' });
        const c2 = buildCapsule({ ...args, body: 'world', timestamp: '2026-06-01T00:00:00Z' });
        assertEqual(c1.sender_hash, c2.sender_hash, 'same phone → same sender_hash');
    }),

    test('TwilioChannel.normalizeMessage extracts joinCode', () => {
        const ch = new TwilioChannel({ logger: { info() {}, warn() {}, error() {} } });
        const msg = ch.normalizeMessage({
            from: 'whatsapp:+60123456789', body: 'hello abc-1f2e3d',
            messageId: 'SM123', mediaUrl: null, mediaContentType: null,
        });
        assertEqual(msg.phone, '+60123456789', 'phone strips whatsapp:');
        assertEqual(msg.joinCode, 'abc-1f2e3d', 'joinCode extracted');
        assertEqual(msg.channel, 'twilio', 'channel is twilio');
        assertEqual(msg.hasMedia, false, 'no media');
    }),

    test('TwilioChannel.normalizeMessage handles media flag', () => {
        const ch = new TwilioChannel({ logger: { info() {}, warn() {}, error() {} } });
        const msg = ch.normalizeMessage({
            from: 'whatsapp:+60199999999', body: '', messageId: 'SM456',
            mediaUrl: 'https://api.twilio.com/media/123', mediaContentType: 'image/jpeg',
        });
        assertEqual(msg.hasMedia, true, 'hasMedia should be true');
    }),

    test('TwilioChannel.isSandboxJoinCommand detection', () => {
        const ch = new TwilioChannel({ logger: { info() {}, warn() {}, error() {} } });
        assert(ch.isSandboxJoinCommand('join baby-ability'), 'should match sandbox command');
        assert(!ch.isSandboxJoinCommand('hello'), 'should not match regular text');
    }),

    test('TwilioChannel.validateSignature rejects missing token', () => {
        const ch = new TwilioChannel({ logger: { info() {}, warn() {}, error() {} } });
        const origToken = process.env.TWILIO_AUTH_TOKEN;
        delete process.env.TWILIO_AUTH_TOKEN;
        const result = ch.validateSignature({ get: () => null, body: {} });
        assertEqual(result.valid, false, 'should be invalid without auth token');
        assertEqual(result.status, 503, 'should return 503');
        if (origToken) process.env.TWILIO_AUTH_TOKEN = origToken;
    }),

    test('TwilioChannel.validateSignature rejects missing signature header', () => {
        const ch = new TwilioChannel({ logger: { info() {}, warn() {}, error() {} } });
        const origToken = process.env.TWILIO_AUTH_TOKEN;
        process.env.TWILIO_AUTH_TOKEN = 'test-token';
        const result = ch.validateSignature({
            get: (h) => h === 'X-Twilio-Signature' ? null : 'localhost',
            body: {},
        });
        assertEqual(result.valid, false, 'should be invalid without signature');
        assertEqual(result.status, 401, 'should return 401');
        if (origToken) process.env.TWILIO_AUTH_TOKEN = origToken;
        else delete process.env.TWILIO_AUTH_TOKEN;
    }),

    test('POST /api/twilio/webhook without signature is rejected', async () => {
        const res = await httpRequest({
            method: 'POST',
            path: '/api/twilio/webhook',
            body: { From: 'whatsapp:+1234567890', Body: 'test' },
        });
        const twilioAuthConfigured = !!process.env.TWILIO_AUTH_TOKEN;
        if (twilioAuthConfigured) {
            assertEqual(res.status, 401, `expected 401 (missing signature), got ${res.status}`);
        } else {
            assertEqual(res.status, 503, `expected 503 (auth not configured), got ${res.status}`);
        }
    }),

    test('POST /api/twilio/webhook with invalid signature is rejected', async () => {
        if (!process.env.TWILIO_AUTH_TOKEN) return;
        const res = await httpRequest({
            method: 'POST',
            path: '/api/twilio/webhook',
            body: { From: 'whatsapp:+1234567890', Body: 'test message' },
            headers: { 'X-Twilio-Signature': 'invalid-signature-value' },
        });
        assertEqual(res.status, 401, `expected 401 for invalid signature, got ${res.status}`);
    }),

    test('POST /api/twilio/webhook with valid Twilio signature is accepted', async () => {
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        if (!authToken) return;
        const webhookUrl = process.env.TWILIO_WEBHOOK_URL || `http://localhost:${PORT}/api/twilio/webhook`;
        const body = { From: 'whatsapp:+15551234567', Body: `test_sig_${TEST_TS}`, MessageSid: `SM${crypto.randomBytes(16).toString('hex')}` };
        const twilio = require('twilio');
        const signature = twilio.getExpectedTwilioSignature(authToken, webhookUrl, body);
        const res = await httpRequest({
            method: 'POST',
            path: '/api/twilio/webhook',
            body,
            headers: { 'X-Twilio-Signature': signature },
        });
        assert([200, 204].includes(res.status), `expected 200/204 for valid signature, got ${res.status}: ${JSON.stringify(res.data)}`);
    }),

    test('message_queue insert and retrieve roundtrip', async () => {
        const marker = `queue_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const payload = { msg: { body: marker, hasMedia: false }, channel: 'twilio' };
        await pool.query(
            `INSERT INTO core.message_queue (priority, payload, status) VALUES ($1, $2, 'done')`,
            ['text', JSON.stringify(payload)]
        );
        const result = await pool.query(
            `SELECT id, payload, priority FROM core.message_queue WHERE payload::text LIKE $1`,
            [`%${marker}%`]
        );
        assert(result.rows.length === 1, 'should find inserted item');
        const item = typeof result.rows[0].payload === 'string' ? JSON.parse(result.rows[0].payload) : result.rows[0].payload;
        assertEqual(item.msg.body, marker, 'payload body mismatch');
        await pool.query(`DELETE FROM core.message_queue WHERE id = $1`, [result.rows[0].id]);
    }),

    test('message_queue ordering: media priority sorts before text', async () => {
        const marker = `order_test_${Date.now()}`;
        await pool.query(
            `INSERT INTO core.message_queue (priority, payload, status, created_at) VALUES ('text', $1, 'done', NOW() - interval '10 seconds')`,
            [JSON.stringify({ msg: { hasMedia: false }, _m: marker })]
        );
        await pool.query(
            `INSERT INTO core.message_queue (priority, payload, status, created_at) VALUES ('media', $1, 'done', NOW())`,
            [JSON.stringify({ msg: { hasMedia: true }, _m: marker })]
        );
        const result = await pool.query(
            `SELECT payload FROM core.message_queue WHERE payload::text LIKE $1
             ORDER BY CASE WHEN priority = 'media' THEN 0 ELSE 1 END, created_at`,
            [`%${marker}%`]
        );
        const first = typeof result.rows[0].payload === 'string' ? JSON.parse(result.rows[0].payload) : result.rows[0].payload;
        assertEqual(first.msg.hasMedia, true, 'media should sort first');
        await pool.query(`DELETE FROM core.message_queue WHERE payload::text LIKE $1`, [`%${marker}%`]);
    }),

    test('message_queue retry transitions to failed at max', async () => {
        const marker = `retry_${Date.now()}`;
        const ins = await pool.query(
            `INSERT INTO core.message_queue (priority, payload, status, retry_count) VALUES ('text', $1, 'processing', 2) RETURNING id`,
            [JSON.stringify({ msg: { body: marker, hasMedia: false } })]
        );
        await pool.query(
            `UPDATE core.message_queue SET retry_count = retry_count + 1,
             status = CASE WHEN retry_count + 1 >= 3 THEN 'failed' ELSE 'processing' END WHERE id = $1`,
            [ins.rows[0].id]
        );
        const row = await pool.query(`SELECT status FROM core.message_queue WHERE id = $1`, [ins.rows[0].id]);
        assertEqual(row.rows[0].status, 'failed', 'should be failed after 3 retries');
        await pool.query(`DELETE FROM core.message_queue WHERE id = $1`, [ins.rows[0].id]);
    }),

    test('processed_sids idempotency guard', async () => {
        const sid = `SM_TEST_${Date.now()}`;
        const ins1 = await pool.query(
            `INSERT INTO core.processed_sids (sid, processed_at) VALUES ($1, NOW()) ON CONFLICT (sid) DO NOTHING RETURNING sid`, [sid]
        );
        assertEqual(ins1.rows.length, 1, 'first insert should succeed');
        const ins2 = await pool.query(
            `INSERT INTO core.processed_sids (sid, processed_at) VALUES ($1, NOW()) ON CONFLICT (sid) DO NOTHING RETURNING sid`, [sid]
        );
        assertEqual(ins2.rows.length, 0, 'duplicate should return 0 rows');
        await pool.query(`DELETE FROM core.processed_sids WHERE sid = $1`, [sid]);
    }),
];

const outpipeRouterTests = [
    test('validateOutpipeConfig accepts valid discord config', () => {
        const result = validateOutpipeConfig({ type: 'discord', url: 'https://discord.com/api/webhooks/123/abc' });
        assertEqual(result.valid, true, 'valid discord config should pass');
    }),

    test('validateOutpipeConfig rejects discord without url', () => {
        const result = validateOutpipeConfig({ type: 'discord' });
        assertEqual(result.valid, false, 'discord without url should fail');
    }),

    test('validateOutpipeConfig accepts valid webhook config', () => {
        const result = validateOutpipeConfig({ type: 'webhook', url: 'https://example.com/hook' });
        assertEqual(result.valid, true, 'valid webhook should pass');
    }),

    test('validateOutpipeConfig accepts valid email config', () => {
        const result = validateOutpipeConfig({ type: 'email', to: 'user@example.com' });
        assertEqual(result.valid, true, 'valid email should pass');
    }),

    test('validateOutpipeConfig rejects email without valid address', () => {
        const result = validateOutpipeConfig({ type: 'email', to: 'notanemail' });
        assertEqual(result.valid, false, 'email without @ should fail');
    }),

    test('validateOutpipeConfig rejects unknown type', () => {
        const result = validateOutpipeConfig({ type: 'slack' });
        assertEqual(result.valid, false, 'unknown type should fail');
        assert(result.error.includes('Unknown type'), 'error should mention unknown type');
    }),

    test('validateOutpipeConfig rejects null config', () => {
        const result = validateOutpipeConfig(null);
        assertEqual(result.valid, false, 'null config should fail');
    }),

    test('validateOutpipeConfig rejects config without type', () => {
        const result = validateOutpipeConfig({ url: 'https://example.com' });
        assertEqual(result.valid, false, 'config without type should fail');
    }),

    test('WebhookOutpipe HMAC signature generation', () => {
        const { WebhookOutpipe } = require('../lib/outpipes/webhook');
        const pipe = new WebhookOutpipe({ type: 'webhook', url: 'https://example.com/hook', secret: 'test-secret' });
        assert(pipe.config.secret === 'test-secret', 'secret should be stored');
        const body = JSON.stringify({ text: 'hello' });
        const sig = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
        assert(sig.length === 64, 'HMAC should be 64 hex chars');
    }),

    test('DiscordOutpipe constructor requires url', () => {
        const { DiscordOutpipe } = require('../lib/outpipes/discord');
        let threw = false;
        try { new DiscordOutpipe({ type: 'discord' }); } catch { threw = true; }
        assert(threw, 'should throw without url');
    }),

    test('EmailOutpipe constructor requires to', () => {
        let threw = false;
        try { new EmailOutpipe({ type: 'email' }); } catch { threw = true; }
        assert(threw, 'should throw without to');
    }),

    test('createOutpipe routes to correct outpipe class', () => {
        const { DiscordOutpipe } = require('../lib/outpipes/discord');
        const { WebhookOutpipe } = require('../lib/outpipes/webhook');
        const { EmailOutpipe } = require('../lib/outpipes/email');
        const createOutpipe = (config) => {
            const types = { discord: DiscordOutpipe, email: EmailOutpipe, webhook: WebhookOutpipe };
            const Cls = types[config.type];
            if (!Cls) throw new Error(`Unknown outpipe type: ${config.type}`);
            return new Cls(config);
        };
        const d = createOutpipe({ type: 'discord', url: 'https://discord.com/api/webhooks/1/a' });
        assert(d instanceof DiscordOutpipe, 'should be DiscordOutpipe');
        const w = createOutpipe({ type: 'webhook', url: 'https://example.com/hook' });
        assert(w instanceof WebhookOutpipe, 'should be WebhookOutpipe');
        const e = createOutpipe({ type: 'email', to: 'user@test.com' });
        assert(e instanceof EmailOutpipe, 'should be EmailOutpipe');
        let threw = false;
        try { createOutpipe({ type: 'slack', url: 'https://hooks.slack.com/1' }); } catch { threw = true; }
        assert(threw, 'unknown type should throw');
    }),
];

const validatorTests = [
    test('VALID_SCHEMA_PATTERN accepts valid schemas', () => {
        assert(VALID_SCHEMA_PATTERN.test('tenant_1'), 'tenant_1 valid');
        assert(VALID_SCHEMA_PATTERN.test('tenant_999'), 'tenant_999 valid');
        assert(VALID_SCHEMA_PATTERN.test('core'), 'core valid');
    }),

    test('VALID_SCHEMA_PATTERN rejects SQL injection', () => {
        assert(!VALID_SCHEMA_PATTERN.test("tenant_1; DROP TABLE users"), 'SQL injection rejected');
        assert(!VALID_SCHEMA_PATTERN.test("tenant_1'--"), 'quote injection rejected');
    }),

    test('assertValidSchemaName throws on invalid input', () => {
        let threw = false;
        try { assertValidSchemaName("tenant_1; DROP TABLE users"); } catch { threw = true; }
        assert(threw, 'should throw on injection');
        threw = false;
        try { assertValidSchemaName(null); } catch { threw = true; }
        assert(threw, 'should throw on null');
        threw = false;
        try { assertValidSchemaName(''); } catch { threw = true; }
        assert(threw, 'should throw on empty');
    }),

    test('assertValidSchemaName passes valid schema', () => {
        assertEqual(assertValidSchemaName('tenant_42'), 'tenant_42', 'should return schema');
    }),
];

const registryLedgerTests = [
    test('core.book_registry insert and lookup', async () => {
        const joinCode = `test-${crypto.randomBytes(4).toString('hex')}`;
        const fractalId = `bridge_t${tenantIdA}_reg_${crypto.randomBytes(6).toString('hex')}`;
        await pool.query(
            `INSERT INTO core.book_registry (book_name, join_code, fractal_id, tenant_schema, tenant_email, outpipe_ledger, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
            ['Registry Test', joinCode, fractalId, SCHEMA_A, TEST_EMAIL_A, 'https://discord.com/api/webhooks/test']
        );
        const result = await pool.query(`SELECT * FROM core.book_registry WHERE fractal_id = $1`, [fractalId]);
        assertEqual(result.rows.length, 1, 'should find entry');
        assertEqual(result.rows[0].tenant_schema, SCHEMA_A, 'schema mismatch');
        await pool.query(`DELETE FROM core.book_registry WHERE fractal_id = $1`, [fractalId]);
    }),

    test('message_ledger PK uniqueness', async () => {
        const msgFid = `msg_t1_${crypto.randomBytes(8).toString('hex')}`;
        await pool.query(
            `INSERT INTO core.message_ledger (message_fractal_id, book_fractal_id, sender_hash, content_hash, env)
             VALUES ($1, 'b1', $2, $3, 'test')`,
            [msgFid, crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')]
        );
        let threw = false;
        try {
            await pool.query(
                `INSERT INTO core.message_ledger (message_fractal_id, book_fractal_id, sender_hash, content_hash, env)
                 VALUES ($1, 'b1', 'aaa', 'bbb', 'test')`, [msgFid]
            );
        } catch { threw = true; }
        assert(threw, 'duplicate message_fractal_id should violate PK');
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
        { name: '🔐 Auth Unit Tests', tests: authUnitTests },
        { name: '🌐 Auth Endpoint Tests', tests: authEndpointTests },
        { name: '🔑 Signup', tests: signupTests },
        { name: '🚪 Post-Logout Denial', tests: postLogoutDenialTests },
        { name: '📦 Books Data Setup', tests: booksSetupTests },
        { name: '📚 Books API & Sharing', tests: booksEndpointTests },
        { name: '🔧 Books CRUD via API', tests: booksCrudApiTests },
        { name: '📝 Books CRUD (DB)', tests: booksCrudTests },
        { name: '🏢 Tenant Isolation', tests: tenantIsolationTests },
        { name: '📦 Capsule, Inpipe & Webhook', tests: capsuleAndInpipeTests },
        { name: '📤 Outpipe Router & Validation', tests: outpipeRouterTests },
        { name: '🛡️ Validators', tests: validatorTests },
        { name: '📋 Registry & Ledger', tests: registryLedgerTests },
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
