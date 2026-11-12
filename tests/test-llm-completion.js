'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { completionMetadata, requireCompletionText } = require('../lib/llm-completion');
const { publicAIError } = require('../lib/ai-errors');

test('empty and truncated paid completions cannot become placeholder answers', () => {
    for (const content of ['', null, undefined, [], '   ']) {
        assert.throws(() => requireCompletionText({ choices: [{ message: { content } }] }),
            error => error.code === 'AI_RESPONSE_EMPTY' && error.providerCompleted);
    }
    assert.throws(() => requireCompletionText({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }),
        error => error.code === 'AI_RESPONSE_TRUNCATED' && error.providerCompleted);
    assert.equal(requireCompletionText({ choices: [{ finish_reason: 'stop', message: { content: 'Natural answer.' } }] }), 'Natural answer.');
});

test('diagnostics record only finish/usage metadata, never content or hidden reasoning', () => {
    const metadata = completionMetadata({
        choices: [{ finish_reason: 'length', message: { content: '', reasoning: 'private' } }],
        usage: { completion_tokens: 800, completion_tokens_details: { reasoning_tokens: 800 } }
    });
    assert.deepEqual(metadata, { finishReason: 'length', contentChars: 0, completionTokens: 800, reasoningTokens: 800 });
    assert.doesNotMatch(JSON.stringify(metadata), /private/);
});

test('completion and verification contract errors have honest public failures', () => {
    for (const code of ['AI_RESPONSE_EMPTY', 'AI_RESPONSE_TRUNCATED', 'AI_AUDIT_INVALID']) {
        const result = publicAIError({ code });
        assert.equal(result.status, 502);
        assert.equal(result.code, code);
        assert.match(result.message, /not retried automatically/);
    }
});
