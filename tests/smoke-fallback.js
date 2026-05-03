#!/usr/bin/env node
process.env.NYAN_LLM_TOOL_FALLBACK = 'true';
const { createPipelineOrchestrator } = require('../utils/pipeline-orchestrator');
const { searchKernel } = require('../lib/tools/search-kernel');
const { searchBrave } = require('../lib/tools/brave-search');
const { searchDuckDuckGo } = require('../lib/tools/duckduckgo');
const { searchCascade, searchCascadeMulti } = require('../lib/tools/search-cascade');
const { groqWithRetry, resolveAIToken } = require('../utils/groq-client');

const o = createPipelineOrchestrator({
  groqToken: resolveAIToken('playground'),
  auditToken: resolveAIToken('playground'),
  groqVisionToken: resolveAIToken('vision'),
  searchKernel, searchBrave, searchDuckDuckGo, searchCascade, searchCascadeMulti,
  extractCoreQuestion: async m => m, isIdentityQuery: () => false, groqWithRetry
});

(async () => {
  const queries = [
    'detect the language of this sentence: bonjour le monde comment ca va',
    'extract entities from: Apple CEO Tim Cook visited Paris last March',
  ];
  for (const q of queries) {
    const t0 = Date.now();
    console.log('\n━━', q);
    try {
      const r = await o.execute({ message: q, clientIp: 'fb-' + Date.now(), history: [] });
      console.log('→', JSON.stringify({
        success: r.success, mode: r.mode, provider: r.searchProvider,
        badge: r.badge, ans: (r.answer || '').length,
        dt: ((Date.now() - t0) / 1000).toFixed(1) + 's'
      }));
    } catch (e) { console.log('✗', e.message); }
  }
  process.exit(0);
})();
