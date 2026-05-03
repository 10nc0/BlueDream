#!/usr/bin/env node
process.env.NYAN_LLM_TOOL_FALLBACK = process.env.NYAN_LLM_TOOL_FALLBACK || 'true';

const { createPipelineOrchestrator } = require('../utils/pipeline-orchestrator');
const { searchKernel } = require('../lib/tools/search-kernel');
const { searchBrave } = require('../lib/tools/brave-search');
const { searchDuckDuckGo } = require('../lib/tools/duckduckgo');
const { searchCascade, searchCascadeMulti } = require('../lib/tools/search-cascade');
const { groqWithRetry, resolveAIToken } = require('../utils/groq-client');

const orchestrator = createPipelineOrchestrator({
  groqToken: resolveAIToken('playground'),
  auditToken: resolveAIToken('playground'),
  groqVisionToken: resolveAIToken('vision'),
  searchKernel,
  searchBrave,
  searchDuckDuckGo,
  searchCascade,
  searchCascadeMulti,
  extractCoreQuestion: async (m) => m,
  isIdentityQuery: () => false,
  groqWithRetry
});

const QUERIES = [
  { label: 'GENERAL (LLM tool fallback target)', query: 'What is the population of Tokyo and the capital of Mongolia?' },
  { label: 'SEED-METRIC',                         query: 'seed metric for Lisbon' },
  { label: 'PSI-EMA',                             query: 'psi ema for AAPL' },
];

(async () => {
  let pass = 0, fail = 0;
  for (const t of QUERIES) {
    const t0 = Date.now();
    console.log(`\n━━ ${t.label} ━━\n  query: ${t.query}`);
    try {
      const r = await orchestrator.execute({ message: t.query, clientIp: 'smoke-' + Date.now(), history: [] });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const ok = r && r.success;
      const provider = r?.searchProvider || r?.state?.searchProvider || 'n/a';
      const mode     = r?.mode || 'n/a';
      const ansLen   = (r?.answer || '').length;
      const badge    = r?.badge || 'n/a';
      console.log(`  → success=${ok} mode=${mode} provider=${provider} badge=${badge} ans=${ansLen}ch  (${dt}s)`);
      if (ok) { pass++; } else { fail++; console.log(`    error: ${r?.error || 'unknown'}`); }
    } catch (e) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      fail++;
      console.log(`  ✗ THREW after ${dt}s: ${e.message}`);
      console.log(e.stack?.split('\n').slice(0, 5).join('\n'));
    }
  }
  console.log(`\n${pass}/${QUERIES.length} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
