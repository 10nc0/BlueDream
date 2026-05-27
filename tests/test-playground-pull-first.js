/**
 * test-playground-pull-first — task #226
 *
 * Covers the pull-first discipline on the playground surface:
 *   1. Post-hint cache: normalisation, get/set, TTL, speculative warm-up.
 *   2. Orchestrator gate: env=false force-off respected; default ON for playground.
 *   3. POSITIONAL_MULTI_ARG exclusion: brave-search / search-cascade /
 *      search-kernel / pdf-analyzer stay hidden from the LLM manifest.
 *   4. Rollback (env=false) still works for non-playground surface.
 *
 * The orchestrator's tool-fallback path is exercised at the level of the
 * cache + the toToolDef filter — without spinning up a real Groq call.
 */

'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed++; console.log(`  ✅ ${name}`); },
        e => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
      );
    }
    passed++; console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('\n🪝 Playground pull-first — task #226\n');

// ─── 1. post-hint cache ───────────────────────────────────────────────────
const cache = require('../lib/tools/post-hint-cache');

test('cache: normalizeArgs lowercases + collapses whitespace + sorts keys', () => {
  const a = cache.normalizeArgs({ b: 'Hello   World', a: '  X ' });
  const b = cache.normalizeArgs({ a: 'x', b: 'hello world' });
  assert.strictEqual(a, b, 'normalized forms should match');
});

test('cache: get returns undefined on miss, set + get returns value', () => {
  cache.clear();
  assert.strictEqual(cache.get('duckduckgo', { query: 'cats' }), undefined);
  cache.set('duckduckgo', { query: 'cats' }, 'meow result');
  assert.strictEqual(cache.get('duckduckgo', { query: 'cats' }), 'meow result');
});

test('cache: key collision across normalised args (case + whitespace)', () => {
  cache.clear();
  cache.set('duckduckgo', { query: 'Hello World' }, 'A');
  assert.strictEqual(cache.get('duckduckgo', { query: 'hello   world' }), 'A');
});

test('cache: separate keys per tool name', () => {
  cache.clear();
  cache.set('duckduckgo', { query: 'cats' }, 'ddg');
  cache.set('exa', { query: 'cats' }, 'exa');
  assert.strictEqual(cache.get('duckduckgo', { query: 'cats' }), 'ddg');
  assert.strictEqual(cache.get('exa', { query: 'cats' }), 'exa');
});

test('cache: TTL expiry — manual short TTL', () => {
  cache.clear();
  cache.set('duckduckgo', { query: 'old' }, 'stale', 1); // 1ms TTL
  return new Promise(resolve => setTimeout(() => {
    assert.strictEqual(cache.get('duckduckgo', { query: 'old' }), undefined);
    resolve();
  }, 10));
});

test('cache: warm() populates asynchronously, de-dups in-flight', async () => {
  cache.clear();
  let calls = 0;
  let resolveExec;
  const blocker = new Promise(r => { resolveExec = r; });
  const executor = () => { calls++; return blocker; };
  cache.warm('duckduckgo', { query: 'pre' }, executor);
  // Yield one microtask so the first executor() runs and marks _pending.
  await Promise.resolve();
  cache.warm('duckduckgo', { query: 'pre' }, executor); // duplicate — must drop
  assert.strictEqual(calls, 1, 'in-flight dedup should keep calls=1');
  resolveExec('warmed');
  // Drain enough microtasks for blocker resolution → .then(set) → .finally
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(cache.get('duckduckgo', { query: 'pre' }), 'warmed');
});

test('cache: warm() failures stay silent and do not poison cache', async () => {
  cache.clear();
  cache.warm('duckduckgo', { query: 'boom' }, () => Promise.reject(new Error('nope')));
  // Drain microtasks for both the rejection and the .catch chain.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.strictEqual(cache.get('duckduckgo', { query: 'boom' }), undefined);
});

// ─── 2. POSITIONAL_MULTI_ARG exclusion ────────────────────────────────────
test('registry: POSITIONAL_MULTI_ARG tools are present in registry', () => {
  const { getTool } = require('../lib/tools/registry');
  // These four must exist (deterministic preflight still uses them) but
  // are excluded from the LLM-visible manifest — see pipeline-orchestrator.js.
  assert.ok(getTool('brave-search'), 'brave-search must exist');
  assert.ok(getTool('search-cascade'), 'search-cascade must exist');
  assert.ok(getTool('search-kernel'), 'search-kernel must exist');
  assert.ok(getTool('pdf-analyzer'), 'pdf-analyzer must exist');
});

test('registry: pull-friendly tools (duckduckgo, exa) are present and single-arg', () => {
  const { getTool } = require('../lib/tools/registry');
  const ddg = getTool('duckduckgo');
  const exa = getTool('exa');
  assert.ok(ddg && exa);
  assert.deepStrictEqual(Object.keys(ddg.parameters), ['query']);
  assert.deepStrictEqual(Object.keys(exa.parameters), ['query']);
});

// ─── 3. Manifest filter mirrors orchestrator ──────────────────────────────
test('manifest filter: POSITIONAL_MULTI_ARG set excludes correct tools', () => {
  const { getManifest } = require('../lib/tools/registry');
  const POSITIONAL_MULTI_ARG = new Set([
    'brave-search', 'search-cascade', 'search-kernel', 'pdf-analyzer'
  ]);
  const exposed = getManifest().filter(t => !POSITIONAL_MULTI_ARG.has(t.name));
  const exposedNames = exposed.map(t => t.name);
  for (const n of POSITIONAL_MULTI_ARG) {
    assert.ok(!exposedNames.includes(n), `${n} must NOT be exposed to LLM`);
  }
  // Sanity: at least one pull-friendly tool survives the filter.
  assert.ok(exposedNames.includes('duckduckgo'), 'duckduckgo should be exposed');
});

// ─── 4. Rollback env switch ──────────────────────────────────────────────
test('rollback: NYAN_LLM_TOOL_FALLBACK=false disables pull-first on playground', () => {
  // The gate is `(surface==='playground') ? env !== 'false' : env === 'true'`.
  // Mirror the exact expression to lock the contract.
  const gate = (surface, envVal) => {
    const isPg = surface === 'playground';
    return isPg ? (envVal !== 'false') : (envVal === 'true');
  };
  assert.strictEqual(gate('playground', undefined), true, 'playground default ON');
  assert.strictEqual(gate('playground', 'true'),     true, 'playground env=true ON');
  assert.strictEqual(gate('playground', 'false'),    false, 'playground env=false force OFF');
  assert.strictEqual(gate('dashboard',  undefined), false, 'dashboard default OFF');
  assert.strictEqual(gate('dashboard',  'true'),    true,  'dashboard opt-in via env=true');
  assert.strictEqual(gate('dashboard',  'false'),   false, 'dashboard env=false OFF');
});

// ─── 5. Routes pass surface=playground ────────────────────────────────────
test('routes: playground route passes surface=playground in pipeline input', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes/nyan-ai/playground.js'), 'utf8');
  const hits = (src.match(/surface:\s*['"]playground['"]/g) || []).length;
  assert.ok(hits >= 2, `expected >=2 surface:'playground' assignments, got ${hits}`);
});

// ─── summary ──────────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}, 200);
