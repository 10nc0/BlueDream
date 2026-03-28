'use strict';

const logger = require('../logger');
const { detectForexPair, fetchForexRate, isValidCurrency } = require('../../utils/forex-fetcher');

module.exports = {
    name: 'forex',
    description: 'Look up live currency exchange rates. Accepts either explicit base/quote ISO 4217 currency codes (e.g., USD, JPY) or a natural-language query (e.g., "dollar to yen"). Returns rate, inverse rate, currency names, and data date. Read-only — only validated 3-letter currency codes are sent to the public API.',
    parameters: {
        base: { type: 'string', required: false, description: '3-letter ISO 4217 base currency code (e.g., USD). Optional if query is provided.' },
        quote: { type: 'string', required: false, description: '3-letter ISO 4217 quote currency code (e.g., JPY). Optional if query is provided.' },
        query: { type: 'string', required: false, description: 'Natural-language forex query (e.g., "dollar to yen", "USDJPY"). Used when base/quote are not explicitly provided.' }
    },

    async execute(params) {
        let resolvedBase = null;
        let resolvedQuote = null;

        try {
            const parsed = typeof params === 'string'
                ? { query: params }
                : (params || {});

            const rawBase = typeof parsed.base === 'string' ? parsed.base.trim() : null;
            const rawQuote = typeof parsed.quote === 'string' ? parsed.quote.trim() : null;
            const rawQuery = typeof parsed.query === 'string' ? parsed.query.trim() : null;

            resolvedBase = rawBase ? rawBase.toUpperCase() : null;
            resolvedQuote = rawQuote ? rawQuote.toUpperCase() : null;

            if (resolvedBase && !isValidCurrency(resolvedBase)) {
                return { success: false, error: `Invalid base currency code: "${resolvedBase}". Must be a valid ISO 4217 code.` };
            }
            if (resolvedQuote && !isValidCurrency(resolvedQuote)) {
                return { success: false, error: `Invalid quote currency code: "${resolvedQuote}". Must be a valid ISO 4217 code.` };
            }

            if (!resolvedBase || !resolvedQuote) {
                if (!rawQuery) {
                    return { success: false, error: 'Provide either {base, quote} currency codes or a {query} string.' };
                }
                const detected = detectForexPair(rawQuery);
                if (!detected) {
                    return { success: false, error: `Could not detect a currency pair from query: "${rawQuery}"` };
                }
                if (!resolvedBase) resolvedBase = detected.base;
                if (!resolvedQuote) resolvedQuote = detected.quote;
            }

            const result = await fetchForexRate(resolvedBase, resolvedQuote);

            if (result.error) {
                logger.warn({ base: resolvedBase, quote: resolvedQuote, error: result.error }, '💱 forex tool: fetch failed');
                return { success: false, error: result.error, pair: result.pair };
            }

            logger.debug({ pair: result.pair, rate: result.rate }, '💱 forex tool: rate fetched');

            return {
                success: true,
                base: result.base,
                quote: result.quote,
                pair: result.pair,
                rate: result.rate,
                inverseRate: result.inverseRate,
                baseName: result.baseName,
                quoteName: result.quoteName,
                date: result.date,
                source: result.source
            };
        } catch (err) {
            logger.error({ err, base: resolvedBase, quote: resolvedQuote }, '💱 forex tool: error');
            return { success: false, error: err.message };
        }
    }
};
