'use strict';
// Regression tests: tests/test-source-ascriber.js
// If you change stripLLMSources, injectSourceLine, or the emoji handling, run:
//   node tests/test-source-ascriber.js

const { modelIdToLabel } = require('../prompts/pharma-analysis');
const { getLLMBackend }   = require('../config/constants');
const { REGISTRY_VERSION } = require('../prompts/nyan-identity');

function stripLLMSources(text) {
  return text
    // multi-line bullet block (LLM-generated, with or without 📚)
    // NOTE: 📚 is U+1F4DA (supplementary plane). Without the `u` flag JS splits it into
    // two UTF-16 surrogate code units; `📚?` makes only the second surrogate optional while
    // leaving the first required — so bare **Sources:** blocks are never stripped.
    // Fix: wrap the whole emoji + optional whitespace in a non-capturing group.
    .replace(/\n+(?:📚\s*)?\s*\*\*Sources?:?\*\*\n(?:[ \t]*[-*][^\n]*\n?)*/gi, '')
    // single-line format (orchestrator canonical or LLM echo)
    .replace(/\n+(?:📚\s*)?\s*\*\*Sources?:?\*\*[^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

function ascribeSource(flags = {}) {
  const { psiEmaDirectOutput, seedMetricDirectOutput, mode, didSearch, searchProvider, searchSourceUrls, seedMetricSourceUrls } = flags;
  const model = modelIdToLabel(getLLMBackend().model);

  if (mode === 'nyan-identity')  return `Nyan Identity Registry v${REGISTRY_VERSION} — https://github.com/10nc0/BlueDream`;
  if (psiEmaDirectOutput)        return 'yfinance + SEC EDGAR (live data)';
  if (seedMetricDirectOutput) {
    const smUrls = Array.isArray(seedMetricSourceUrls) ? seedMetricSourceUrls : [];
    const seen = new Set();
    const parts = smUrls.map(u => {
      try {
        const host = new URL(u.url).hostname.replace(/^www\./, '');
        if (seen.has(host)) return null;
        seen.add(host);
        const label = u.title
          ? u.title.replace(/\s*—.*$/, '').replace(/\s*\(.*$/, '').trim()
          : host;
        return `[${label}](${u.url})`;
      } catch { return null; }
    }).filter(Boolean).slice(0, 6);
    return parts.length > 0 ? parts.join(', ') : 'BIS · FRED · World Bank · Numbeo (live data)';
  }
  if (mode === 'forex')          return 'fawazahmed0 — live FX rates';

  if (didSearch) {
    const urls = Array.isArray(searchSourceUrls) ? searchSourceUrls : [];
    const parts = urls.slice(0, 5).map(u => {
      try {
        const host = new URL(u).hostname.replace(/^www\./, '');
        return `[${host}](${u})`;
      } catch { return null; }
    }).filter(Boolean);
    parts.push(`${model} training data`);
    return parts.join(', ');
  }

  return `${model} training data`;
}

function injectSourceLine(text, flags) {
  const cleaned = stripLLMSources(text);
  const label   = ascribeSource(flags);
  const line    = `\n\n📚 **Sources:** ${label}`;
  // After stripping the sources block the trailing `\n?` in the strip regex consumes one
  // of the two \n characters that precede 🔥, leaving only a single \n before the
  // signature.  Match one-or-more \n so the 📚 line is always inserted before 🔥
  // regardless of how many newlines remain.
  const sigIdx  = cleaned.search(/\n+🔥/);
  if (sigIdx !== -1) {
    return cleaned.slice(0, sigIdx) + line + cleaned.slice(sigIdx);
  }
  return cleaned.trimEnd() + line;
}

module.exports = { stripLLMSources, ascribeSource, injectSourceLine };
