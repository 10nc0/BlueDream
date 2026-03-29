'use strict';

const logger = require('../logger');

let _ddg = null;
let _brave = null;

function _loadProviders() {
  if (!_ddg) _ddg = require('./duckduckgo');
  if (!_brave) _brave = require('./brave-search');
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
