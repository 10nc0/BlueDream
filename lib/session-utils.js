const format = require('pg-format');
const logger = require('./logger');
const { VALID_SCHEMA_PATTERN } = require('./validators');
const fractalId = require('../utils/fractal-id');
const { parseUserAgent } = require('../utils/parse-helpers');

async function getBookTenantSchema(fractalIdInput) {
    try {
        const parsed = fractalId.parse(fractalIdInput);
        if (parsed && Number.isInteger(parsed.tenantId) && parsed.tenantId > 0 && parsed.tenantId <= 999999) {
            const tenantSchema = `tenant_${parsed.tenantId}`;
            logger.debug({ fractalId: fractalIdInput, tenantSchema }, 'Parsed fractal_id');
            return tenantSchema;
        }
        const numericId = parseInt(fractalIdInput);
        if (!isNaN(numericId)) {
            logger.error({ numericId }, 'DEPRECATED: Numeric book ID rejected — use fractal_id instead');
            throw new Error(`Legacy numeric book ID not supported. Use fractal_id format.`);
        }
        logger.error({ fractalId: fractalIdInput }, 'Invalid fractal_id format — refusing to fall back to public schema');
        throw new Error(`Invalid fractal_id format: ${fractalIdInput}`);
    } catch (error) {
        logger.error({ fractalId: fractalIdInput, err: error }, 'Error resolving tenant for book');
        throw error;
    }
}

async function createSessionRecord(pool, userId, sessionId, req, tenantSchema) {
    try {
        const userAgent = req.get('user-agent') || '';
        const { deviceType, browser, os } = parseUserAgent(userAgent);
        const ip = req.ip || '';
        const location = (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.'))
            ? 'Local Network'
            : 'Unknown Location';
        if (!tenantSchema || tenantSchema === 'undefined' || !VALID_SCHEMA_PATTERN.test(tenantSchema)) {
            logger.error({ tenantSchema }, 'Session creation: invalid tenant schema');
            return;
        }
        await pool.query(
            format(`INSERT INTO %I.active_sessions (user_id, session_id, ip_address, user_agent, device_type, browser, os, location) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, tenantSchema),
            [userId, sessionId, req.ip, userAgent, deviceType, browser, os, location]);
        logger.info({ userId, deviceType, browser, os, ip: req.ip, location }, '🆕 Session created');
    } catch (error) {
        logger.error({ err: error }, 'Error creating session record');
    }
}

async function logAudit(client, req, actionType, targetType, targetId, targetEmail, details = {}, tenantSchema = null) {
    try {
        const actorUserId = req.userId || req.session?.userId || null;
        let actorEmail = req.userEmail || null;
        const schema = tenantSchema || req.tenantSchema;
        if (!schema) {
            logger.warn('Audit logging skipped — no tenant schema available');
            return;
        }
        if (!VALID_SCHEMA_PATTERN.test(schema)) {
            logger.error({ schema }, 'Audit logging: invalid schema skipped');
            return;
        }
        if (actorUserId && !actorEmail) {
            const userResult = await client.query(
                format(`SELECT email FROM %I.users WHERE id = $1`, schema),
                [actorUserId]
            );
            actorEmail = userResult.rows[0]?.email || null;
        }
        await client.query(
            format(`INSERT INTO %I.audit_logs (
                actor_user_id, action_type, target_type,
                target_id, details, ip_address, user_agent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`, schema),
            [
                actorUserId,
                actionType,
                targetType,
                targetId,
                JSON.stringify(details),
                req.ip || req.connection?.remoteAddress || 'system',
                (req.get && typeof req.get === 'function') ? req.get('user-agent') : 'system'
            ]);
    } catch (error) {
        logger.error({ err: error }, 'Audit logging failed');
    }
}

module.exports = { getBookTenantSchema, createSessionRecord, logAudit };
