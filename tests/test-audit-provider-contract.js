#!/usr/bin/env node
'use strict';

const assert = require('assert');
const axios = require('axios');
const { runAuditPass } = require('../utils/two-pass-verification');

async function run() {
  const originalPost = axios.post;
  let capturedBody = null;
  let callbackModel = null;

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
        onProviderResponse: result => { callbackModel = result.model; },
        timestamps: {
          isoDate: '2026-09-20',
          isoDateTime: '2026-09-20T14:02:00.000Z',
          year: 2026
        }
      },
      15000
    );

    assert(capturedBody, 'audit request body must be sent');
    assert.strictEqual(capturedBody.model, 'meta/muse-ember');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(capturedBody, 'response_format'),
      true,
      'Muse Ember audit requests must use supported JSON mode'
    );
    assert.strictEqual(capturedBody.max_tokens, 800, 'do not raise the audit token cap');
    assert.deepStrictEqual(capturedBody.reasoning, { effort: 'minimal' });
    assert.strictEqual(capturedBody.response_format.type, 'json_schema');
    assert.strictEqual(capturedBody.response_format.json_schema.strict, true);
    assert(capturedBody.response_format.json_schema.schema.required.includes('verdict'));
    assert.strictEqual(result.verdict, 'APPROVED');
    assert.strictEqual(result.confidence, 97);
    assert.strictEqual(result.providerContractValid, true);
    assert.strictEqual(callbackModel, 'meta/muse-ember');

    axios.post = async () => ({
      data: { choices: [{ message: { content: 'not-json' } }] }
    });
    const malformed = await runAuditPass('test-token', 'Synthetic answer.', 'Synthetic question?', 'Synthetic context.',
      { useDialectical: false }, 15000);
    assert.strictEqual(malformed.verdict, 'REJECTED');
    assert.strictEqual(malformed.error, 'JSON_PARSE_ERROR',
      'invalid provider JSON must remain a failed audit, not be broadened into a fallback approval');
    assert.strictEqual(malformed.providerContractValid, false);

    axios.post = async () => ({
      data: { choices: [{ message: { content: '' } }] }
    });
    const empty = await runAuditPass('test-token', 'Synthetic answer.', 'Synthetic question?', 'Synthetic context.',
      { useDialectical: false }, 15000);
    assert.strictEqual(empty.error, 'JSON_PARSE_ERROR');
    assert.strictEqual(empty.providerContractValid, false);
    for (const content of ['null', '[]', '{"verdict":4}', '{"verdict":"BYPASS","confidence":99}',
      '{"verdict":"APPROVED","confidence":101,"checksPass":[],"issues":[],"suggestedFixes":[]}']) {
      axios.post = async () => ({ data: { choices: [{ message: { content } }] } });
      const invalid = await runAuditPass('test-token', 'Fixture', 'Question', '', {}, 15000);
      assert.strictEqual(invalid.verdict, 'REJECTED');
      assert.strictEqual(invalid.providerContractValid, false);
    }
    axios.post = async () => ({ data: { choices: [{
      finish_reason: 'length',
      message: { content: '{"verdict":"APPROVED","confidence":97,"checksPass":[],"issues":[],"suggestedFixes":[]}' }
    }] } });
    const truncated = await runAuditPass('test-token', 'Fixture', 'Question', '', {}, 15000);
    assert.strictEqual(truncated.error, 'AUDIT_TRUNCATED', 'even syntactically valid truncated JSON cannot approve');
    assert.strictEqual(truncated.providerContractValid, false);
    console.log('Muse Ember audit contract test passed');
  } finally {
    axios.post = originalPost;
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});