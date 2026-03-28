'use strict';

const logger = require('../logger');

const PLATE_REGEX = /\b([A-Z]{1,2})\s*(\d{1,4})\s*([A-Z]{1,3})\b/gi;

const CURRENCY_REGEX = /(?:(?:USD|EUR|GBP|JPY|CNY|IDR|SGD|MYR|THB|AUD|CAD|CHF|KRW|INR|PHP|VND|BRL|MXN|ZAR|NZD|SEK|NOK|DKK|HKD|TWD|ARS|CLP|COP|PEN|PLN|CZK|HUF|RON|TRY|AED|SAR)\s*[\d,.]+|[\d,.]+\s*(?:USD|EUR|GBP|JPY|CNY|IDR|SGD|MYR|THB|AUD|CAD|CHF|KRW|INR|PHP|VND|BRL|MXN|ZAR|NZD|SEK|NOK|DKK|HKD|TWD|ARS|CLP|COP|PEN|PLN|CZK|HUF|RON|TRY|AED|SAR)|[$€£¥₹₩₱₫₪₺฿]\s*[\d,.]+|[\d,.]+\s*[$€£¥₹₩₱₫₪₺฿]|(?:Rp|RM|S\$|HK\$|A\$|C\$|NZ\$|R\$)\s*[\d,.]+)/gi;

const DATE_REGEX = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?)\b/gi;

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

const PHONE_REGEX = /(?:\+?\d{1,4}[\s.-]?)?\(?\d{1,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{1,4})?/g;

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

const SYMBOL_MAP = {
    '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY',
    '₹': 'INR', '₩': 'KRW', '₱': 'PHP', '₫': 'VND',
    '₪': 'ILS', '₺': 'TRY', '฿': 'THB'
};

const PREFIX_MAP = {
    'rp': 'IDR', 'rm': 'MYR', 's$': 'SGD', 'hk$': 'HKD',
    'a$': 'AUD', 'c$': 'CAD', 'nz$': 'NZD', 'r$': 'BRL'
};

function normalizePlate(raw) {
    return raw.replace(/\s+/g, ' ').toUpperCase().trim();
}

function normalizeCurrency(raw) {
    let cleaned = raw.trim();
    let currency = null;

    const codeMatch = cleaned.match(/\b(USD|EUR|GBP|JPY|CNY|IDR|SGD|MYR|THB|AUD|CAD|CHF|KRW|INR|PHP|VND|BRL|MXN|ZAR|NZD|SEK|NOK|DKK|HKD|TWD|ARS|CLP|COP|PEN|PLN|CZK|HUF|RON|TRY|AED|SAR)\b/i);
    if (codeMatch) {
        currency = codeMatch[1].toUpperCase();
    } else {
        for (const [sym, code] of Object.entries(SYMBOL_MAP)) {
            if (cleaned.includes(sym)) { currency = code; break; }
        }
        if (!currency) {
            const lower = cleaned.toLowerCase();
            for (const [pfx, code] of Object.entries(PREFIX_MAP)) {
                if (lower.startsWith(pfx)) { currency = code; break; }
            }
        }
    }

    const numMatch = cleaned.match(/[\d,.]+/);
    const amount = numMatch ? numMatch[0].replace(/,/g, '') : cleaned;

    return currency ? `${currency} ${amount}` : cleaned;
}

function normalizeDate(raw) {
    return raw.trim().replace(/\s+/g, ' ');
}

function extractEntities(text) {
    if (!text || typeof text !== 'string') return [];

    const entities = [];

    let match;

    PLATE_REGEX.lastIndex = 0;
    while ((match = PLATE_REGEX.exec(text)) !== null) {
        const full = match[0];
        if (/^\d+$/.test(full)) continue;
        entities.push({ type: 'license_plate', value: normalizePlate(full), position: match.index });
    }

    CURRENCY_REGEX.lastIndex = 0;
    while ((match = CURRENCY_REGEX.exec(text)) !== null) {
        entities.push({ type: 'currency_amount', value: normalizeCurrency(match[0]), position: match.index });
    }

    DATE_REGEX.lastIndex = 0;
    while ((match = DATE_REGEX.exec(text)) !== null) {
        entities.push({ type: 'date', value: normalizeDate(match[0]), position: match.index });
    }

    EMAIL_REGEX.lastIndex = 0;
    while ((match = EMAIL_REGEX.exec(text)) !== null) {
        entities.push({ type: 'email', value: match[0].toLowerCase(), position: match.index });
    }

    URL_REGEX.lastIndex = 0;
    while ((match = URL_REGEX.exec(text)) !== null) {
        entities.push({ type: 'url', value: match[0], position: match.index });
    }

    PHONE_REGEX.lastIndex = 0;
    while ((match = PHONE_REGEX.exec(text)) !== null) {
        const digits = match[0].replace(/\D/g, '');
        if (digits.length >= 7 && digits.length <= 15) {
            const isInsideCurrency = entities.some(e =>
                e.type === 'currency_amount' &&
                match.index >= e.position &&
                match.index < e.position + e.value.length + 5
            );
            if (!isInsideCurrency) {
                entities.push({ type: 'phone', value: match[0].trim(), position: match.index });
            }
        }
    }

    return entities;
}

function tallyEntities(allEntities) {
    const tally = new Map();

    for (const entity of allEntities) {
        const key = `${entity.type}::${entity.value}`;
        if (!tally.has(key)) {
            tally.set(key, { type: entity.type, value: entity.value, count: 0, positions: [] });
        }
        const entry = tally.get(key);
        entry.count++;
        entry.positions.push(entity.position);
    }

    return [...tally.values()].sort((a, b) => b.count - a.count);
}

module.exports = {
    name: 'entity-extractor',
    description: 'Extract structured entities (license plates, currency amounts, dates, emails, phone numbers, URLs) from text. Returns deduplicated entities with occurrence counts. Stateless — no data is stored.',
    parameters: {
        text: { type: 'string', required: true, description: 'Text to extract entities from. Can be a single message or concatenated messages.' }
    },

    async execute(text) {
        if (!text || typeof text !== 'string') {
            return { success: false, error: 'No text provided', entities: [] };
        }

        try {
            const raw = extractEntities(text);
            const entities = tallyEntities(raw);

            const summary = {};
            for (const e of entities) {
                summary[e.type] = (summary[e.type] || 0) + 1;
            }

            logger.debug({ totalUnique: entities.length, types: summary }, '🔍 entity-extractor: extraction complete');

            return {
                success: true,
                entities,
                summary,
                totalUnique: entities.length,
                totalOccurrences: raw.length
            };
        } catch (err) {
            logger.error({ err }, '🔍 entity-extractor: error');
            return { success: false, error: err.message, entities: [] };
        }
    },

    extractEntities,
    tallyEntities
};
