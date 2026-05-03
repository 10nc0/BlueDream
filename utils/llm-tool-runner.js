'use strict';

/**
 * llm-tool-runner — generic Groq function-calling primitives.
 *
 * Two callers today (utils/pipeline-orchestrator.js):
 *   1. stepSeedMetricToolCall — bespoke brave_search tool def, structured post-processing.
 *   2. stepPreflight LLM tool fallback — full registry, generic post-processing.
 *
 * Helper stays minimal: schema mapping + a thin Groq roundtrip wrapper +
 * a single-call tool executor with arity adaptation. Bespoke prompt-building
 * and result post-processing stay at the call site.
 */

const logger = require('../lib/logger');

/**
 * Convert a registry tool entry to Groq's function-calling JSON schema.
 * Hyphens in tool names become underscores (Groq function names disallow
 * hyphens) — runToolCall reverses this when looking the tool back up.
 */
function toToolDef(tool) {
  const props = {};
  const required = [];
  for (const [key, spec] of Object.entries(tool.parameters || {})) {
    props[key] = {
      type: spec.type || 'string',
      ...(spec.description ? { description: spec.description } : {})
    };
    if (spec.required) required.push(key);
  }
  return {
    type: 'function',
    function: {
      name: tool.name.replace(/-/g, '_'),
      description: tool.description,
      parameters: {
        type: 'object',
        properties: props,
        ...(required.length ? { required } : {})
      }
    }
  };
}

/**
 * Single-round LLM call with tools. The caller passes the bound
 * groqWithRetry so the helper stays decoupled from config wiring.
 *
 * Returns { content, toolCalls, finishReason }. Never throws on a
 * "no tool call" reply — that is a valid outcome (LLM declined).
 */
async function callWithTools({
  groqCall, url, model, token, timeout = 30000,
  messages, tools, toolChoice = 'auto',
  temperature = 0.15, maxTokens = 800
}) {
  const response = await groqCall({
    url,
    data: { model, messages, tools, tool_choice: toolChoice, temperature, max_tokens: maxTokens },
    config: {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout
    }
  }, 3, 'text');

  const choice = response.data?.choices?.[0] || {};
  const msg = choice.message || {};
  return {
    content: msg.content || '',
    toolCalls: msg.tool_calls || [],
    finishReason: choice.finish_reason || null
  };
}

// Detect whether a tool's execute() destructures its first argument
// (e.g. `execute({ text })` or `execute({ type, query } = {})`).
// Such tools want the full args object even if they only declare 1 parameter.
function _firstArgIsDestructured(fn) {
  const src = fn.toString();
  // Match the opening of the param list, allowing `async`, optional name, and whitespace.
  return /^\s*(?:async\s+)?(?:function\s*\w*\s*)?\(\s*\{/.test(src);
}

/**
 * Execute one LLM-returned tool_call against the registry.
 *
 * Arity adapter (lets single-positional and object-arg tools coexist
 * without per-tool wrappers):
 *   - tool with >1 declared parameters       → tool.execute(args)
 *   - tool whose execute destructures arg #1 → tool.execute(args)   (e.g. language-detector({text}))
 *   - tool with exactly 1 declared parameter → tool.execute(args[paramName])
 *
 * Multi-positional tools (e.g. brave-search(query, clientIp, opts)) must
 * be filtered out by the caller before the manifest goes to the LLM.
 */
async function runToolCall(toolCall, getTool) {
  const fnName = toolCall.function?.name || '';
  const registryName = fnName.replace(/_/g, '-');
  const tool = getTool(registryName) || getTool(fnName);

  let args = {};
  try { args = JSON.parse(toolCall.function?.arguments || '{}'); }
  catch (_) { args = {}; }

  if (!tool) {
    logger.warn({ name: fnName }, '🔧 LLM tool runner: unknown tool');
    return { name: fnName, args, error: 'tool_not_found' };
  }

  const paramKeys = Object.keys(tool.parameters || {});
  const useObjectStyle = paramKeys.length > 1 || _firstArgIsDestructured(tool.execute);

  try {
    const result = useObjectStyle
      ? await tool.execute(args)
      : await tool.execute(args[paramKeys[0]]);
    return { name: tool.name, args, result };
  } catch (err) {
    logger.warn({ name: tool.name, err: err.message }, '🔧 LLM tool runner: execute failed');
    return { name: tool.name, args, error: err.message };
  }
}

module.exports = { toToolDef, callWithTools, runToolCall };
