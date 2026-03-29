function extractPsiEmaFields(src) {
    if (!src) return null;
    if (src.dimensions) {
        const reading = src.reading || {};
        const phase = src.dimensions.phase || {};
        const anomaly = src.dimensions.anomaly || {};
        const convergence = src.dimensions.convergence || {};
        const fidelity = src.fidelity || {};
        return {
            theta: phase.current ?? null,
            z: anomaly.current ?? null,
            R: convergence.currentDisplay ?? convergence.current ?? null,
            reading: reading.reading || src.summary?.reading || null,
            emoji: reading.emoji || src.summary?.readingEmoji || null,
            description: reading.description || null,
            fidelity: fidelity.breakdown || null,
            regime: src.summary?.regime || null
        };
    }
    return {
        reading: src.reading ?? null,
        emoji: src.emoji ?? null,
        theta: src.theta ?? null,
        z: src.z ?? null,
        R: src.R ?? null,
        fidelity: src.fidelity ?? null
    };
}

function extractPsiEmaFromAnalysis(analysis) {
    return extractPsiEmaFields(analysis);
}

function extractPsiEma(preflight) {
    if (!preflight?.psiEmaAnalysis) return null;
    const result = { daily: extractPsiEmaFields(preflight.psiEmaAnalysis) };
    if (preflight.psiEmaAnalysisWeekly) result.weekly = extractPsiEmaFields(preflight.psiEmaAnalysisWeekly);
    return result;
}

function splitMultiTicker(message) {
    const trimmed = message.trim();
    const tickerMatches = trimmed.match(/\$[A-Z]{1,5}\b/g);
    const isComparison = /\b(compare|vs\.?|versus|correlation|relative|against|ratio|between)\b/i.test(trimmed);
    if (!tickerMatches || tickerMatches.length <= 1 || isComparison) return null;
    const uniqueTickers = [...new Set(tickerMatches)];
    if (uniqueTickers.length <= 1) return null;
    const baseQuery = trimmed
        .replace(/\$[A-Z]{1,5}\b/g, '')
        .replace(/\b(and|,|&|also|plus)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (baseQuery.length > 0) {
        return uniqueTickers.slice(0, 5).map(ticker => ({ query: `${ticker} ${baseQuery}`, label: ticker }));
    }
    const { detectPsiEMAKeys } = require('./stock-fetcher');
    const hasPsiEmaIntent = detectPsiEMAKeys(trimmed).shouldTrigger;
    const suffix = hasPsiEmaIntent ? 'psi-ema' : 'analysis';
    return uniqueTickers.slice(0, 5).map(ticker => ({ query: `${ticker} ${suffix}`, label: ticker }));
}

module.exports = { extractPsiEmaFields, extractPsiEmaFromAnalysis, extractPsiEma, splitMultiTicker };
