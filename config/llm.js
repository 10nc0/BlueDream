'use strict';

// One application-managed model/provider. Caller-owned BYOK remains separate.
const LLM_MODEL = 'meta/muse-ember';
const LLM_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const resolveLLMToken = () => process.env.OPENROUTER_API_KEY;

module.exports = { LLM_MODEL, LLM_API_URL, resolveLLMToken };
