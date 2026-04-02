'use strict';

const logger = require('../logger');

let _ddg = null;
let _brave = null;
let _exa = null;

function _loadProviders() {
  if (!_ddg) _ddg = require('./duckduckgo');
  if (!_brave) _brave = require('./brave-search');
  if (!_exa) _exa = require('./exa');
}

async function cascade({ query, strategy = 'ddg-first', clientIp = null, format } = {}) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { result: null, provider: null };
  }
  _loadProviders();

  const opts = format ? { format } : {};
  const [first, second] = strategy === 'ddg-first'
    ? [{ fn: q => _ddg.execute(q), name: 'ddg' },
       { fn: (q, ip) => _brave.execute(q, ip, opts), name: 'brave' }]
    : [{ fn: (q, ip) => _brave.execute(q, ip, opts), name: 'brave' },
       { fn: q => _ddg.execute(q), name: 'ddg' }];

  let result = await first.fn(query, clientIp);
  if (result) {
    return { result, provider: first.name };
  }

  logger.debug(`🔀 Cascade: ${first.name} returned no results, falling back to ${second.name}`);
  result = await second.fn(query, clientIp);
  if (result) {
    return { result, provider: second.name };
  }

  // Third tier: Exa semantic search — only fires if EXA_API_KEY is set (guarded inside exa.js)
  if (process.env.EXA_API_KEY) {
    logger.debug('🔀 Cascade: falling back to exa');
    result = await _exa.execute(query);
    if (result) {
      return { result, provider: 'exa' };
    }
  }

  return { result: null, provider: null };
}

async function cascadeMulti({ queries, strategy = 'brave-first', clientIp = null, delayMs = 350 } = {}) {
  if (!Array.isArray(queries) || queries.length === 0) return { results: [], providers: [] };

  const results = [];
  const providers = [];

  for (let i = 0; i < queries.length; i++) {
    const { result, provider } = await cascade({ query: queries[i], strategy, clientIp });
    if (result) {
      results.push(`[${queries[i]}]\n${result}`);
      providers.push(provider);
    }
    if (i < queries.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { results, providers };
}

module.exports = {
  name: 'search-cascade',
  description: 'Unified search cascade — DDG→Brave or Brave→DDG with automatic fallback. Single entry point for all web search.',
  parameters: {
    query: { type: 'string', required: true, description: 'Search query' },
    strategy: { type: 'string', required: false, description: "'ddg-first' (default) or 'brave-first'" }
  },

  async execute(query, strategy = 'ddg-first', clientIp = null) {
    const { result } = await cascade({ query, strategy, clientIp });
    return result;
  },

  cascade,
  cascadeMulti
};
