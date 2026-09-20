#!/usr/bin/env node
'use strict';

const assert = require('assert');
const axios = require('axios');
const { runAuditPass } = require('../utils/two-pass-verification');

async function run() {
  const originalPost = axios.post;
  let capturedBody = null;

  axios.post = async (_url, body) => {
    capturedBody = body;
    return {
      data: {
        choices: [{
          message: {
            content: '{"verdict":"APPROVED","confidence":97,"checksPass":["facts"],"issues":[],"suggestedFixes":[]}'
          }
        }]
      }
    };
  };

  try {
    const result = await runAuditPass(
      'test-token',
      'Two plus two equals four.',
      'What is two plus two?',
      {
        thesis: 'Basic arithmetic.',
        antithesis: 'What is two plus two?',
        synthesis: 'Two plus two equals four.'
      },
      {
        useDialectical: true,
        timestamps: {
          isoDate: '2026-09-20',
          isoDateTime: '2026-09-20T14:02:00.000Z',
          year: 2026
        }
      },
      15000
    );

    assert(capturedBody, 'audit request body must be sent');
    assert.strictEqual(capturedBody.model, 'meta-llama/llama-3.3-70b-instruct');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(capturedBody, 'response_format'),
      true,
      'OpenRouter Llama audit requests must use supported JSON mode'
    );
    assert.deepStrictEqual(capturedBody.response_format, { type: 'json_object' });
    assert.strictEqual(result.verdict, 'APPROVED');
    assert.strictEqual(result.confidence, 97);
    console.log('✅ OpenRouter Llama audit contract test passed');
  } finally {
    axios.post = originalPost;
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});