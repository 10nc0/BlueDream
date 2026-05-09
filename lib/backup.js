'use strict';

const { execFile } = require('child_process');
const zlib = require('zlib');
const { promisify } = require('util');
const FormData = require('form-data');
const axios = require('axios');
const logger = require('./logger');

const { getActiveResolution } = require('./db-resolver');
const { BRAND } = require('../config/brand');

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(zlib.gzip);

const _store = {
    lastRun: null,
    lastSuccess: null,
    lastSize: null,
    lastChannel: null,
    lastStatus: 'never',
    lastError: null,
    tenantCount: null,
    ledgerRowCount: null,
    messageId: null,
    botUsed: null,
};

function getLastBackupStatus() {
    return { ..._store };
}

async function _getMetadata(pool) {
    const tenantResult = await pool.query(`
        SELECT COUNT(DISTINCT schema_name) AS count
        FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
    `);
    const ledgerResult = await pool.query(`
        SELECT COUNT(*) AS count FROM core.message_ledger
    `);
    return {
        tenantCount: parseInt(tenantResult.rows[0].count, 10),
        ledgerRowCount: parseInt(ledgerResult.rows[0].count, 10),
    };
}

async function _pgDump() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        // Backup needs a single connection string for pg_dump. PG* vars alone
        // are not sufficient; surface a clear, actionable error so the caller
        // can degrade gracefully without exploding the workflow.
        const err = new Error('DATABASE_URL is not set — automated pg_dump backup disabled. Set DATABASE_URL to enable.');
        err.code = 'BACKUP_NO_URL';
        throw err;
    }
    const { stdout } = await execFileAsync('pg_dump', ['--no-password', url], {
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
    });
    return stdout;
}

async function runBackup(pool) {
    const channelId = process.env.BACKUP_DISCORD_CHANNEL_ID;

    if (!channelId) {
        logger.warn('⚠️ BACKUP_DISCORD_CHANNEL_ID not set — automated database backup skipped');
        _store.lastStatus = 'skipped';
        return;
    }

    const hermesToken = process.env.HERMES_TOKEN;
    const thothToken = process.env.THOTH_TOKEN;
    const botToken = hermesToken || thothToken;
    const botLabel = hermesToken ? 'hermes' : (thothToken ? 'thoth' : null);

    if (!botToken) {
        logger.warn('⚠️ No bot token available (HERMES_TOKEN or THOTH_TOKEN) — automated database backup skipped');
        _store.lastStatus = 'skipped';
        return;
    }

    // pg_dump needs a single URL. Skip cleanly when:
    //   (a) DATABASE_URL is unset, OR
    //   (b) the kernel resolver is actively using PG* fallback because
    //       DATABASE_URL failed handshake — running pg_dump against the dead
    //       URL would just throw on every backup tick.
    const activeDb = getActiveResolution();
    const activeSource = activeDb ? activeDb.source : 'unknown';
    const activeHost = activeDb ? activeDb.shortHost : 'unknown';
    if (!process.env.DATABASE_URL) {
        logger.warn({ activeSource, activeHost }, '⚠️ DATABASE_URL is not set — automated database backup disabled (pg_dump requires a single URL). Set DATABASE_URL to enable.');
        _store.lastStatus = 'skipped';
        return;
    }
    if (activeDb && activeDb.source !== 'DATABASE_URL') {
        logger.warn({ activeSource, activeHost }, '⚠️ Database resolver is using PG* fallback (DATABASE_URL failed handshake at boot) — automated backup disabled to avoid pg_dump against a dead URL.');
        _store.lastStatus = 'skipped';
        return;
    }
    logger.info({ activeSource, activeHost }, '🗄️ Automated backup: using active DB resolver source');

    _store.lastRun = new Date().toISOString();
    _store.lastStatus = 'running';

    try {
        logger.info({ bot: botLabel }, '🗄️ Automated backup: starting pg_dump...');

        const [dumpBuffer, meta] = await Promise.all([
            _pgDump(),
            _getMetadata(pool),
        ]);

        logger.info({ dumpBytes: dumpBuffer.length }, '🗄️ Automated backup: pg_dump complete, compressing...');

        const compressed = await gzipAsync(dumpBuffer);
        const nowUtc = new Date().toUTCString();
        const filename = `${BRAND.backupPrefix}_${new Date().toISOString().replace(/[:.]/g, '-')}.sql.gz`;
        const sizeMb = (compressed.length / (1024 * 1024)).toFixed(2);

        const embed = {
            title: '🗄️ Automated Database Backup',
            color: 0x57f287,
            fields: [
                { name: 'Timestamp (UTC)', value: nowUtc, inline: false },
                { name: 'Tenants', value: String(meta.tenantCount), inline: true },
                { name: 'Ledger rows', value: String(meta.ledgerRowCount), inline: true },
                { name: 'Dump size', value: `${sizeMb} MB (gzip)`, inline: true },
                { name: 'Filename', value: filename, inline: false },
            ],
            footer: { text: 'Restore: gunzip backup.sql.gz | psql "$DATABASE_URL"' },
        };

        const payload = {
            content: '',
            embeds: [embed],
        };

        const form = new FormData();
        form.append('files[0]', compressed, {
            filename,
            contentType: 'application/gzip',
        });
        form.append('payload_json', JSON.stringify(payload));

        const response = await axios.post(
            `https://discord.com/api/v10/channels/${channelId}/messages`,
            form,
            {
                headers: {
                    Authorization: `Bot ${botToken}`,
                    ...form.getHeaders(),
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            }
        );

        _store.lastSuccess = new Date().toISOString();
        _store.lastSize = compressed.length;
        _store.lastChannel = channelId;
        _store.lastStatus = 'ok';
        _store.lastError = null;
        _store.tenantCount = meta.tenantCount;
        _store.ledgerRowCount = meta.ledgerRowCount;
        _store.messageId = response.data?.id || null;
        _store.botUsed = botLabel;

        logger.info(
            { channelId, sizeMb, tenants: meta.tenantCount, ledgerRows: meta.ledgerRowCount, messageId: _store.messageId, bot: botLabel },
            '✅ Automated backup: posted to Discord successfully'
        );
    } catch (err) {
        _store.lastStatus = 'error';
        _store.lastError = err.message;
        logger.error({ err }, '❌ Automated backup: failed');
        throw err;
    }
}

module.exports = { runBackup, getLastBackupStatus };
