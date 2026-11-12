'use strict';
const { EMPTY_TABLE_ROW_REGEX } = require('./parse-helpers');

// Pure Seed Metric output operations: no provider calls, budgets or pipeline state.
function extractCities(tableText) {
    const cities = new Set();
    for (const line of tableText.split('\n')) {
        if (!/^\|/.test(line.trim())) continue;
        const cols = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length < 7 || EMPTY_TABLE_ROW_REGEX.test(cols[0]) || /City/i.test(cols[0])) continue;
        const city = cols[0].replace(/\*\*/g, '').trim().toLowerCase();
        if (city) cities.add(city);
    }
    return [...cities];
}

function reattachSources(body, sourceUrls) {
    if (!sourceUrls?.length || /\*\*Sources:\*\*/i.test(body)) return body;
    const seen = new Set(), lines = [];
    for (const src of sourceUrls) {
        if (seen.has(src.url)) continue;
        seen.add(src.url);
        lines.push(`- [${src.title}](${src.url})`);
    }
    return lines.length ? body.trimEnd() + `\n**Sources:**\n${lines.slice(0, 5).join('\n')}` : body;
}

function insertCoda(body, coda) {
    if (!coda) return body;
    const header = body.search(/\n\*\*Sources:\*\*/m);
    if (header !== -1) return body.slice(0, header).trimEnd() + '\n\n' + coda + '\n\n' + body.slice(header).trimStart();
    const sources = body.search(/\n[-*] \[|^[-*] \[/m);
    if (sources !== -1) return body.slice(0, sources).trimEnd() + '\n\n' + coda + '\n\n**Sources:**\n' + body.slice(sources).trimStart();
    return body + '\n\n' + coda;
}

function extractMeta(text) {
    const match = text.match(/<!--SEED_META:(\{[\s\S]*?\})-->/);
    let meta = null;
    if (match) {
        try { meta = JSON.parse(match[1]); } catch { /* optional metadata only */ }
    }
    return { meta, text: text.replace(/\s*<!--SEED_META:[\s\S]*?-->\s*/g, '\n').trim() };
}

function normalizeRegimes(text) {
    return text.replace(/^\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|(?:([^|\n]+)\|)?$/gm,
        (row, c1, c2, c3, c4, c5, c6, c7, c8) => {
            if (EMPTY_TABLE_ROW_REGEX.test(c1) || /^\s*years\s*$/i.test(c6)) return row;
            const years = parseInt(c6.replace(/[^0-9]/g, ''), 10);
            if (isNaN(years)) return row;
            const regime = years < 10 ? '🟢 OPTIMISM' : years <= 25 ? '🟡 EXTRACTION' : '🔴 FATALISM';
            return `|${c1}|${c2}|${c3}|${c4}|${c5}|${c6}| ${regime} |${c8 !== undefined ? `${c8}|` : ''}`;
        });
}

module.exports = { extractCities, reattachSources, insertCoda, extractMeta, normalizeRegimes };
