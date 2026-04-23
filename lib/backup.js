'use strict';

const { execFile } = require('child_process');
const zlib = require('zlib');
const { promisify } = require('util');
const FormData = require('form-data');
const axios = require('axios');
const logger = require('./logger');

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
    if (!url) throw new Error('DATABASE_URL is not set');
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
        const filename = `nyanbook_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.sql.gz`;
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
