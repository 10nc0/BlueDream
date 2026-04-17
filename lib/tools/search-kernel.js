'use strict';

const logger = require('../logger');

const TIERS = {
  free:     ['ddg'],
  standard: ['ddg', 'brave'],
  premium:  ['brave', 'ddg'],
  semantic: ['exa', 'brave', 'ddg'],
};

const RATE_GAPS_MS = {
  brave: 1000,
};

class SearchKernel {
  constructor() {
    this._providers = {};
    this._lastCall  = {};
  }

  _load() {
    if (!this._providers.ddg)   this._providers.ddg   = require('./duckduckgo');
    if (!this._providers.brave) this._providers.brave = require('./brave-search');
    if (!this._providers.exa)   this._providers.exa   = require('./exa');
  }

  _keyOk(provider) {
    if (provider === 'brave') return !!process.env.PLAYGROUND_BRAVE_API;
    if (provider === 'exa')   return !!process.env.EXA_API_KEY;
    return true;
  }

  _rateOk(provider) {
    const gap = RATE_GAPS_MS[provider];
    if (!gap) return true;
    const last = this._lastCall[provider] || 0;
    return (Date.now() - last) >= gap;
  }

  _touch(provider) {
    this._lastCall[provider] = Date.now();
  }

  _resolveChain(tier) {
    const chain = TIERS[tier] || TIERS.standard;
    return chain.filter(p => this._keyOk(p));
  }

  async _callProvider(providerName, query, clientIp, format) {
    const p = this._providers[providerName];
    if (!p) return null;

    if (providerName === 'brave') {
      const opts = format && format !== 'text' ? { format } : {};
      return p.execute(query, clientIp, opts);
    }

    return p.execute(query);
  }

  /**
   * Run a single search query through the tier-appropriate provider chain.
   *
   * @param {object} opts
   * @param {string}  opts.query
   * @param {string}  [opts.tier='standard']   free | standard | premium | semantic
   * @param {string}  [opts.clientIp=null]
   * @param {string}  [opts.format='text']     'text' | 'json' (Brave only)
   * @returns {Promise<{ result: string|null, provider: string|null, tier: string, latencyMs: number }>}
   */
  async search({ query, tier = 'standard', clientIp = null, format = 'text' } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { result: null, provider: null, tier, latencyMs: 0 };
    }

    this._load();
    const chain  = this._resolveChain(tier);
    const t0     = Date.now();

    for (const providerName of chain) {
      if (!this._rateOk(providerName)) {
        logger.debug(`⏱️ SearchKernel: ${providerName} rate-limited (tier=${tier}), skipping`);
        continue;
      }

      this._touch(providerName);
      const result = await this._callProvider(providerName, query, clientIp, format);

      if (result) {
        const latencyMs = Date.now() - t0;
        logger.debug(`🔍 SearchKernel: ${providerName} → ${result.length} chars (tier=${tier}, ${latencyMs}ms)`);
        return { result, provider: providerName, tier, latencyMs };
      }

      logger.debug(`🔍 SearchKernel: ${providerName} returned null (tier=${tier}), trying next`);
    }

    logger.debug(`🔍 SearchKernel: all providers exhausted (tier=${tier})`);
    return { result: null, provider: null, tier, latencyMs: Date.now() - t0 };
  }

  /**
   * Run multiple queries sequentially with a delay between each.
   *
   * @param {object} opts
   * @param {string[]} opts.queries
   * @param {string}   [opts.tier='premium']
   * @param {string}   [opts.clientIp=null]
   * @param {number}   [opts.delayMs=350]
   * @returns {Promise<{ results: string[], providers: string[] }>}
   */
  async searchMulti({ queries, tier = 'premium', clientIp = null, delayMs = 350 } = {}) {
    if (!Array.isArray(queries) || queries.length === 0) {
      return { results: [], providers: [] };
    }

    const results   = [];
    const providers = [];

    for (let i = 0; i < queries.length; i++) {
      const { result, provider } = await this.search({ query: queries[i], tier, clientIp });
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
}

const searchKernel = new SearchKernel();

module.exports = {
  SearchKernel,
  searchKernel,

  // Tool registry interface — allows registry auto-load without warnings
  name: 'search-kernel',
  description: 'Tiered search kernel — DDG, Brave, Exa behind a unified interface. Tier selects provider chain by resource availability.',
  parameters: {
    query: { type: 'string', required: true,  description: 'Search query' },
    tier:  { type: 'string', required: false, description: "'free' | 'standard' | 'premium' | 'semantic'" }
  },
  async execute(query, tier = 'standard', clientIp = null) {
    const { result } = await searchKernel.search({ query, tier, clientIp });
    return result;
  },
};
