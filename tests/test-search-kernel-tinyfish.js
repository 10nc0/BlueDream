#!/usr/bin/env node
'use strict';

const assert = require('assert');
const axios = require('axios');
const { SearchKernel } = require('../lib/tools/search-kernel');
const { ascribeSource } = require('../utils/source-ascriber');

const originalEnv = {
  TINYFISH_API_KEY: process.env.TINYFISH_API_KEY,
  PLAYGROUND_BRAVE_API: process.env.PLAYGROUND_BRAVE_API
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeKernel(calls, values = {}) {
  const kernel = new SearchKernel();
  kernel._providers = {
    tinyfish: {
      execute: async () => {
        calls.push('tinyfish');
        return values.tinyfish ?? null;
      }
    },
    brave: {
      execute: async () => {
        calls.push('brave');
        return values.brave ?? null;
      }
    },
    ddg: {
      execute: async () => {
        calls.push('ddg');
        return values.ddg ?? null;
      }
    },
    exa: {
      execute: async () => {
        calls.push('exa');
        return values.exa ?? null;
      }
    }
  };
  return kernel;
}

async function run() {
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key';
  process.env.PLAYGROUND_BRAVE_API = 'test-brave-key';

  {
    const calls = [];
    const kernel = makeKernel(calls, { tinyfish: 'tinyfish result', brave: 'brave result' });
    let receivedOptions;
    kernel._providers.tinyfish.execute = async (_query, opts) => {
      calls.push('tinyfish');
      receivedOptions = opts;
      return 'tinyfish result';
    };
    const result = await kernel.search({ query: 'latest AI news', tier: 'generic', domainType: 'news' });
    assert.strictEqual(result.provider, 'tinyfish');
    assert.strictEqual(result.result, 'tinyfish result');
    assert.strictEqual(receivedOptions.domainType, 'news');
    assert.deepStrictEqual(calls, ['tinyfish']);
  }

  {
    const calls = [];
    const kernel = makeKernel(calls, { tinyfish: 'tinyfish result' });
    let receivedOptions;
    kernel._providers.tinyfish.execute = async (_query, opts) => {
      calls.push('tinyfish');
      receivedOptions = opts;
      return 'tinyfish result';
    };
    await kernel.search({ query: 'invalid domain type', tier: 'generic', domainType: 'blogs' });
    assert.strictEqual(receivedOptions.domainType, 'web');
  }

  {
    const calls = [];
    const kernel = makeKernel(calls, { tinyfish: null, brave: 'brave fallback' });
    const result = await kernel.search({ query: 'latest AI news', tier: 'generic' });
    assert.strictEqual(result.provider, 'brave');
    assert.strictEqual(result.result, 'brave fallback');
    assert.deepStrictEqual(calls, ['tinyfish', 'brave']);
  }

  {
    const calls = [];
    const kernel = makeKernel(calls, { tinyfish: 'must not run', brave: 'seed metric fallback' });
    const result = await kernel.search({ query: 'Jakarta income 2025', tier: 'premium' });
    assert.strictEqual(result.provider, 'brave');
    assert.deepStrictEqual(calls, ['brave']);
  }

  {
    delete process.env.TINYFISH_API_KEY;
    const calls = [];
    const kernel = makeKernel(calls, { tinyfish: 'must be skipped', brave: 'brave result' });
    const result = await kernel.search({ query: 'current pricing', tier: 'generic' });
    assert.strictEqual(result.provider, 'brave');
    assert.deepStrictEqual(calls, ['brave']);
  }

  {
    process.env.TINYFISH_API_KEY = 'test-tinyfish-key';
    const originalGet = axios.get;
    axios.get = async (url, config) => {
      assert.strictEqual(url, 'https://api.search.tinyfish.ai');
      assert.strictEqual(config.headers['X-API-Key'], 'test-tinyfish-key');
      assert.strictEqual(config.params.query, 'registry object call');
      assert.strictEqual(config.params.domain_type, 'web');
      assert.match(config.params.purpose, /current, credible sources/);
      return {
        data: {
          results: [{
            title: 'Current source',
            url: 'https://example.com/current',
            snippet: 'Current evidence',
            date: 'today',
            site_name: 'example.com'
          }]
        }
      };
    };

    try {
      const tinyfish = require('../lib/tools/tinyfish-search');
      const result = await tinyfish.execute({ query: 'registry object call', format: 'json' });
      assert.deepStrictEqual(JSON.parse(result), [{
        title: 'Current source',
        url: 'https://example.com/current',
        description: 'Current evidence',
        age: 'today',
        siteName: 'example.com'
      }]);

      const textResult = await tinyfish.execute({ query: 'registry object call', format: 'text' });
      const sourceUrls = [...textResult.matchAll(/^   Source:\s*(https?:\/\/\S+)/gm)].map(match => match[1]);
      assert.deepStrictEqual(sourceUrls, ['https://example.com/current']);

      const sourceLine = ascribeSource({
        didSearch: true,
        searchProvider: 'tinyfish',
        searchSourceUrls: sourceUrls
      });
      assert(
        sourceLine.includes('[example.com](https://example.com/current)'),
        'TinyFish URL must reach the canonical source ascriber'
      );
    } finally {
      axios.get = originalGet;
    }
  }

  {
    process.env.TINYFISH_API_KEY = 'test-tinyfish-key';
    const originalGet = axios.get;
    axios.get = async (_url, config) => {
      assert.strictEqual(config.params.recency_minutes, 1440);
      assert.strictEqual(config.params.after_date, undefined);
      assert.strictEqual(config.params.before_date, undefined);
      assert.strictEqual(config.params.location, 'ID');
      assert.strictEqual(config.params.language, 'id');
      assert.strictEqual(config.params.domain_type, 'news');
      return { data: { results: [{ title: 'Fresh', url: 'https://example.com/fresh', snippet: 'Fresh result' }] } };
    };
    try {
      const tinyfish = require('../lib/tools/tinyfish-search');
      const result = await tinyfish.execute('fresh Jakarta news', {
        format: 'json',
        recencyMinutes: 1440,
        afterDate: '2026-01-01',
        beforeDate: '2026-09-20',
        location: 'id',
        language: 'ID',
        domainType: 'news'
      });
      assert.strictEqual(JSON.parse(result)[0].title, 'Fresh');
    } finally {
      axios.get = originalGet;
    }
  }

  {
    process.env.TINYFISH_API_KEY = 'test-tinyfish-key';
    const originalGet = axios.get;
    axios.get = async (_url, config) => {
      assert.strictEqual(config.params.domain_type, 'research_paper');
      assert.strictEqual(config.params.recency_minutes, undefined);
      assert.strictEqual(config.params.after_date, undefined);
      assert.strictEqual(config.params.before_date, undefined);
      assert.strictEqual(config.params.pub_year_min, 2020);
      assert.strictEqual(config.params.pub_year_max, 2026);
      return { data: { results: [{ title: 'Paper', url: 'https://example.com/paper', snippet: 'Research' }] } };
    };
    try {
      const tinyfish = require('../lib/tools/tinyfish-search');
      const result = await tinyfish.execute('AI safety evaluation', {
        format: 'json',
        domainType: 'research_paper',
        recencyMinutes: 1440,
        afterDate: '2026-01-01',
        beforeDate: '2026-09-20',
        pubYearMin: 2020,
        pubYearMax: 2026
      });
      assert.strictEqual(JSON.parse(result)[0].title, 'Paper');
    } finally {
      axios.get = originalGet;
    }
  }

  restoreEnv();
  console.log('✅ TinyFish generic-search routing tests passed');
}

run().catch(err => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});