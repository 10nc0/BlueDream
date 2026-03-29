'use strict';

const { modelIdToLabel } = require('../prompts/pharma-analysis');
const { getLLMBackend }   = require('../config/constants');
const { REGISTRY_VERSION } = require('../prompts/nyan-identity');

function stripLLMSources(text) {
  return text
    .replace(/\n+📚?\s*\*\*Sources?:?\*\*\n(?:[ \t]*[-*][^\n]*\n?)*/gi, '')
    .replace(/\n+📚?\s*\*\*Sources?:?\*\*[^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

function ascribeSource(flags = {}) {
  const { psiEmaDirectOutput, seedMetricDirectOutput, mode, didSearch, searchProvider, searchSourceUrls } = flags;
  const model = modelIdToLabel(getLLMBackend().model);

  if (mode === 'nyan-identity')  return `Nyan Identity Registry v${REGISTRY_VERSION} — https://github.com/10nc0/BlueDream`;
  if (psiEmaDirectOutput)        return 'yfinance + SEC EDGAR (live data)';
  if (seedMetricDirectOutput)    return 'Brave Search — live $/sqm triangulation';
  if (mode === 'forex')          return 'fawazahmed0 — live FX rates';

  if (didSearch) {
    const urls = Array.isArray(searchSourceUrls) ? searchSourceUrls : [];
    const domainBullets = urls.slice(0, 5).map(u => {
      try { return `- [${new URL(u).hostname}](${u})`; } catch { return null; }
    }).filter(Boolean);
    domainBullets.push(`- ${model} training data`);
    return domainBullets.join('\n');
  }

  return `${model} training data`;
}

function injectSourceLine(text, flags) {
  const cleaned = stripLLMSources(text);
  const label   = ascribeSource(flags);
  const block   = label.includes('\n')
    ? `\n\n📚 **Sources:**\n${label}`
    : `\n\n📚 **Sources:** ${label}`;
  const sigIdx  = cleaned.search(/\n\n🔥/);
  if (sigIdx !== -1) {
    return cleaned.slice(0, sigIdx) + block + cleaned.slice(sigIdx);
  }
  return cleaned.trimEnd() + block;
}

module.exports = { stripLLMSources, ascribeSource, injectSourceLine };
