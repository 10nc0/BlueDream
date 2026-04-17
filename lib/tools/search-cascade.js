'use strict';

const { searchKernel } = require('./search-kernel');

/**
 * cascade — legacy compatibility shim over SearchKernel.
 *
 * Callers that previously used strategy='ddg-first' map to tier='standard'.
 * Callers that previously used strategy='brave-first' map to tier='premium'.
 * The { result, provider } return shape is unchanged.
 */
async function cascade({ query, strategy = 'ddg-first', clientIp = null, format } = {}) {
  const tier = strategy === 'brave-first' ? 'premium' : 'standard';
  const { result, provider } = await searchKernel.search({ query, tier, clientIp, format });
  return { result, provider };
}

async function cascadeMulti({ queries, strategy = 'brave-first', clientIp = null, delayMs = 350 } = {}) {
  const tier = strategy === 'brave-first' ? 'premium' : 'standard';
  return searchKernel.searchMulti({ queries, tier, clientIp, delayMs });
}

module.exports = {
  name: 'search-cascade',
  description: 'Unified search cascade — DDG→Brave or Brave→DDG with automatic fallback. Single entry point for all web search.',
  parameters: {
    query:    { type: 'string', required: true,  description: 'Search query' },
    strategy: { type: 'string', required: false, description: "'ddg-first' (default) or 'brave-first'" }
  },

  async execute(query, strategy = 'ddg-first', clientIp = null) {
    const { result } = await cascade({ query, strategy, clientIp });
    return result;
  },

  cascade,
  cascadeMulti,
};
