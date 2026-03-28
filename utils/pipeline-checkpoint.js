'use strict';

const crypto = require('crypto');
const logger = require('../lib/logger');

const CHECKPOINT_TTL_MS = 5 * 60 * 1000;
const CHECKPOINT_MAX_SIZE = 50;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const RESUMABLE_STAGES = ['S0', 'S1', 'S2', 'S3'];

class PipelineCheckpointStore {
    constructor() {
        this.store = new Map();
        this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }

    _makeKey(query, tenantId) {
        const raw = `${tenantId}:${(query || '').trim().toLowerCase()}`;
        return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    }

    save(query, tenantId, stageId, snapshot) {
        const key = this._makeKey(query, tenantId);
        this.store.set(key, {
            stageId,
            snapshot,
            savedAt: Date.now()
        });

        if (this.store.size > CHECKPOINT_MAX_SIZE) {
            const deleteCount = Math.floor(CHECKPOINT_MAX_SIZE * 0.3);
            const keys = [...this.store.keys()].slice(0, deleteCount);
            keys.forEach(k => this.store.delete(k));
        }

        logger.debug({ key: key.slice(0, 8), stageId }, '💾 Pipeline checkpoint saved');
    }

    restore(query, tenantId) {
        const key = this._makeKey(query, tenantId);
        const entry = this.store.get(key);
        if (!entry) return null;

        if (Date.now() - entry.savedAt > CHECKPOINT_TTL_MS) {
            this.store.delete(key);
            return null;
        }

        logger.info({ key: key.slice(0, 8), stageId: entry.stageId }, '♻️ Pipeline checkpoint restored');
        return entry;
    }

    clear(query, tenantId) {
        const key = this._makeKey(query, tenantId);
        this.store.delete(key);
    }

    _cleanup() {
        const now = Date.now();
        let expired = 0;
        for (const [key, entry] of this.store) {
            if (now - entry.savedAt > CHECKPOINT_TTL_MS) {
                this.store.delete(key);
                expired++;
            }
        }
        if (expired > 0) {
            logger.debug(`🧹 Pipeline checkpoint: cleaned ${expired} expired entries`);
        }
    }

    getStats() {
        return {
            size: this.store.size,
            maxSize: CHECKPOINT_MAX_SIZE,
            ttlMs: CHECKPOINT_TTL_MS
        };
    }
}

function buildResumableSnapshot(state) {
    return JSON.parse(JSON.stringify({
        mode: state.mode,
        preflight: state.preflight,
        contextResult: state.contextResult ? {
            inferredTicker: state.contextResult.inferredTicker,
            hasFinancialContext: state.contextResult.hasFinancialContext,
            hasMemory: state.contextResult.hasMemory,
            attachmentContext: state.contextResult.attachmentContext
        } : null,
        systemMessages: state.systemMessages,
        draftAnswer: state.draftAnswer,
        auditResult: state.auditResult,
        didSearch: state.didSearch,
        searchContext: state.searchContext,
        hasImageAttachment: state.hasImageAttachment,
        retryCount: state.retryCount,
        seedMetricSourceUrls: state.seedMetricSourceUrls,
        isFirstQuery: state.isFirstQuery,
        queryTimestamp: state.queryTimestamp,
        dataPackageStages: state.dataPackage?.stages || {}
    }));
}

function applySnapshot(state, snapshot) {
    if (snapshot.mode) state.mode = snapshot.mode;
    if (snapshot.preflight) state.preflight = snapshot.preflight;
    if (snapshot.contextResult) state.contextResult = snapshot.contextResult;
    if (snapshot.systemMessages) state.systemMessages = snapshot.systemMessages;
    if (snapshot.draftAnswer) state.draftAnswer = snapshot.draftAnswer;
    if (snapshot.auditResult) state.auditResult = snapshot.auditResult;
    if (snapshot.didSearch !== undefined) state.didSearch = snapshot.didSearch;
    if (snapshot.searchContext) state.searchContext = snapshot.searchContext;
    if (snapshot.hasImageAttachment !== undefined) state.hasImageAttachment = snapshot.hasImageAttachment;
    if (snapshot.retryCount !== undefined) state.retryCount = snapshot.retryCount;
    if (snapshot.seedMetricSourceUrls) state.seedMetricSourceUrls = snapshot.seedMetricSourceUrls;
    if (snapshot.isFirstQuery !== undefined) state.isFirstQuery = snapshot.isFirstQuery;
    if (snapshot.queryTimestamp) state.queryTimestamp = snapshot.queryTimestamp;

    if (snapshot.dataPackageStages && state.dataPackage) {
        for (const [stageId, stageData] of Object.entries(snapshot.dataPackageStages)) {
            if (!state.dataPackage.stages[stageId]) {
                state.dataPackage.stages[stageId] = JSON.parse(JSON.stringify(stageData));
            }
        }
    }
}

const globalCheckpointStore = new PipelineCheckpointStore();

module.exports = {
    PipelineCheckpointStore,
    globalCheckpointStore,
    buildResumableSnapshot,
    applySnapshot,
    RESUMABLE_STAGES
};
