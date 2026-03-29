'use strict';

const { modelIdToLabel } = require('../prompts/pharma-analysis');
const { getLLMBackend }   = require('../config/constants');
const { REGISTRY_VERSION } = require('../prompts/nyan-identity');

function stripLLMSources(text) {
  return text
    .replace(/\n+📚?\s*\*\*Sources?:?\*\*[^\n]*/gi, '')
    .replace(/\n\n\*\*Sources?:?\*\*\n(?:[ \t]*[*\-][^\n]*\n?)*/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

function ascribeSource(flags = {}) {
  const { psiEmaDirectOutput, seedMetricDirectOutput, mode, didSearch, searchProvider } = flags;

  if (mode === 'nyan-identity')  return `Nyan Identity Registry v${REGISTRY_VERSION} — https://github.com/10nc0/BlueDream`;
  if (psiEmaDirectOutput)        return 'yfinance + SEC EDGAR (live data)';
  if (seedMetricDirectOutput)    return 'Brave Search — live $/sqm triangulation';
  if (mode === 'forex')          return 'fawazahmed0 — live FX rates';
  if (didSearch && searchProvider === 'brave') return 'Brave Search (live web)';
  if (didSearch)                 return 'DuckDuckGo (live web)';
  return `${modelIdToLabel(getLLMBackend().model)} training data`;
}

function injectSourceLine(text, flags) {
  const cleaned  = stripLLMSources(text);
  const label    = ascribeSource(flags);
  const line     = `\n\n📚 **Sources:** ${label}`;
  const sigIdx   = cleaned.search(/\n\n🔥/);
  if (sigIdx !== -1) {
    return cleaned.slice(0, sigIdx) + line + cleaned.slice(sigIdx);
  }
  return cleaned.trimEnd() + line;
}

module.exports = { stripLLMSources, ascribeSource, injectSourceLine };
