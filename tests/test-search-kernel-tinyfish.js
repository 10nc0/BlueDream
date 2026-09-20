#!/usr/bin/env node
'use strict';

const assert = require('assert');
const axios = require('axios');
const { SearchKernel } = require('../lib/tools/search-kernel');
const { ascribeSource } = require('../utils/source-ascriber');

const originalEnv = {
  MONID_API: process.env.MONID_API,
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
  process.env.MONID_API = 'test-monid-key';
  process.env.PLAYGROUND_BRAVE_API = 'test-brave-key';

  {
    const calls = [];
    const kernel = makeKernel(calls, { tinyfish: 'tinyfish result', brave: 'brave result' });
    const result = await kernel.search({ query: 'latest AI news', tier: 'generic' });
    assert.strictEqual(result.provider, 'tinyfish');
    assert.strictEqual(result.result, 'tinyfish result');
    assert.deepStrictEqual(calls, ['tinyfish']);
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
    delete process.env.MONID_API;
    const calls = [];
    const kernel = makeKernel(calls, { tinyfish: 'must be skipped', brave: 'brave result' });
    const result = await kernel.search({ query: 'current pricing', tier: 'generic' });
    assert.strictEqual(result.provider, 'brave');
    assert.deepStrictEqual(calls, ['brave']);
  }

  {
    process.env.MONID_API = 'test-monid-key';
    const originalPost = axios.post;
    axios.post = async (url, body) => {
      assert.strictEqual(url, 'https://api.monid.ai/v1/run');
      assert.strictEqual(body.provider, 'tinyfish');
      assert.strictEqual(body.endpoint, '/search');
      assert.strictEqual(body.input.queryParams.query, 'registry object call');
      return {
        data: {
          status: 'COMPLETED',
          output: {
            results: [{
              title: 'Current source',
              url: 'https://example.com/current',
              snippet: 'Current evidence',
              date: 'today',
              site_name: 'example.com'
            }]
          }
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
      axios.post = originalPost;
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