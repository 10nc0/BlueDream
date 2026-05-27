'use strict';

/**
 * post-hint-cache — short-TTL cache for LLM-emitted tool calls.
 *
 * The playground pull-first discipline (task #226) lets the LLM choose tools
 * instead of regex pushing evidence. This cache sits BETWEEN the LLM's tool
 * emission and the actual tool execution; it never gates what the LLM sees
 * pre-call. Two uses:
 *   1. Serve a recent identical call without re-hitting the network.
 *   2. Receive non-blocking speculative warm-ups from the orchestrator when
 *      a deterministic regex *would have* fired — so if the LLM independently
 *      picks the same tool/args, the result is already there.
 *
 * Keys: `${toolName}::${normalizedArgs}` — args object lowercased, whitespace
 * collapsed, keys sorted. Values: { result, expiresAt }. Per-tool TTL.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;        // search-like (DDG, brave, exa)
const STABLE_TTL_MS  = 15 * 60 * 1000;       // forex, world-bank, etc.

const STABLE_TOOLS = new Set([
  'forex', 'world-bank', 'wb-tfr', 'fred-series', 'sgp-hdb', 'uk-lr',
  'jpn-bis', 'bis-spp', 'intl-historical-price', 'income-ceiling'
]);

const _cache = new Map();
const _pending = new Map(); // de-dup in-flight speculative warmups

function _ttlFor(toolName) {
  return STABLE_TOOLS.has(toolName) ? STABLE_TTL_MS : DEFAULT_TTL_MS;
}

function normalizeArgs(args) {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args.trim().toLowerCase().replace(/\s+/g, ' ');
  if (typeof args !== 'object') return String(args);
  const sortedKeys = Object.keys(args).sort();
  const flat = {};
  for (const k of sortedKeys) {
    const v = args[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') flat[k] = v.trim().toLowerCase().replace(/\s+/g, ' ');
    else flat[k] = v;
  }
  return JSON.stringify(flat);
}

function makeKey(toolName, args) {
  return `${toolName}::${normalizeArgs(args)}`;
}

function get(toolName, args) {
  const key = makeKey(toolName, args);
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    _cache.delete(key);
    return undefined;
  }
  return entry.result;
}

function set(toolName, args, result, ttlMs) {
  const key = makeKey(toolName, args);
  _cache.set(key, {
    result,
    expiresAt: Date.now() + (ttlMs || _ttlFor(toolName))
  });
}

/**
 * Speculative non-blocking warm-up. Returns immediately; runs the tool
 * in the background and stores the result in cache when it lands. If
 * an identical key is already in-flight, the duplicate is dropped.
 */
function warm(toolName, args, executor) {
  const key = makeKey(toolName, args);
  if (_cache.has(key) || _pending.has(key)) return;
  const p = Promise.resolve()
    .then(() => executor())
    .then(result => {
      if (result !== null && result !== undefined) set(toolName, args, result);
    })
    .catch(() => { /* warm-up failures are silent — pull path will retry on real call */ })
    .finally(() => { _pending.delete(key); });
  _pending.set(key, p);
}

function clear() {
  _cache.clear();
  _pending.clear();
}

function stats() {
  return { size: _cache.size, pending: _pending.size };
}

module.exports = { get, set, warm, makeKey, normalizeArgs, clear, stats };
