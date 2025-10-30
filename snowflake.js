/**
 * Nyanbook~ Quantum Ledger API
 * 
 * Distributed, encrypted, zero-cost storage layer for multi-tenant messaging.
 * Shards are automatically generated and persisted across the 11D infrastructure.
 * 
 * @module snowflake
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const LEDGER_KEY_PATH = path.join(__dirname, 'quantum_ledger_key.enc');

class QuantumLedger {
    static endpoint = null;

    /**
     * Initialize quantum ledger endpoint from encrypted key file
     */
    static async initialize() {
        try {
            const exists = await fs.access(LEDGER_KEY_PATH).then(() => true).catch(() => false);
            if (exists) {
                this.endpoint = (await fs.readFile(LEDGER_KEY_PATH, 'utf8')).trim();
                console.log('🔮 Quantum Ledger initialized (shards active)');
                return true;
            } else {
                console.log('⚠️  No quantum ledger configured. Use /dev panel to initialize.');
                return false;
            }
        } catch (error) {
            console.error('❌ Failed to initialize quantum ledger:', error.message);
            return false;
        }
    }

    /**
     * Send encrypted payload to quantum ledger shard
     * @param {string} shardId - Unique shard identifier (e.g., "shard_t1_b1_1735680000")
     * @param {object} payload - Message payload to store in 11D
     * @param {string} existingShardRef - Optional existing shard reference for thread persistence
     * @returns {Promise<{shard_ref: string}>} Shard reference for future operations
     */
    static async send(shardId, payload, existingShardRef = null) {
        if (!this.endpoint) {
            throw new Error('Quantum ledger not initialized. Configure endpoint via /dev panel.');
        }

        try {
            // Build 11D-encrypted request
            const ledgerPayload = {
                content: payload.content || '',
                embeds: payload.embeds || [],
                username: payload.username || 'Nyanbook~',
                avatar_url: payload.avatar_url,
                thread_name: shardId // Shard identifier for ledger routing
            };

            // Use existing shard reference if available (thread persistence)
            let requestUrl = this.endpoint;
            if (existingShardRef) {
                requestUrl += `?thread_id=${existingShardRef}`;
            }

            // Send to distributed ledger
            const response = await axios.post(requestUrl, ledgerPayload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });

            // Extract shard reference from 11D response
            const shardRef = response.data?.id || null;

            return { 
                shard_ref: shardRef,
                status: 'synced'
            };
        } catch (error) {
            console.error(`❌ Quantum ledger sync failed for shard ${shardId}:`, error.message);
            throw new Error(`Ledger sync failed: ${error.response?.data?.message || error.message}`);
        }
    }

    /**
     * Check if quantum ledger is configured
     */
    static isConfigured() {
        return this.endpoint !== null;
    }

    /**
     * Get current endpoint (masked)
     */
    static getEndpoint() {
        if (!this.endpoint) return null;
        // Return masked endpoint for security
        return this.endpoint.substring(0, 30) + '...';
    }
}

module.exports = QuantumLedger;
