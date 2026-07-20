/**
 * Anthropic prompt caching (BST-587).
 *
 * Places an ephemeral `cache_control` breakpoint on the FINAL message of every
 * Anthropic request. Anthropic caches the longest previously-seen prefix at or
 * above a breakpoint, so marking the conversation tail makes each agent step
 * cache-read everything the previous step sent (system prompt + tools +
 * history) and cache-write only the increment. Breakpoints below Anthropic's
 * minimum cacheable length are ignored server-side (documented API behavior,
 * not a client-side fallback).
 *
 * The wrapper is applied ONLY to hosted Anthropic models in the provider
 * factory. Other providers never see the `anthropic` namespace.
 */

const ANTHROPIC_NAMESPACE = 'anthropic';
const CACHE_CONTROL_KEY = 'cacheControl';
/** Raw wire spelling also honored by @ai-sdk/anthropic's cache-control reader. */
const CACHE_CONTROL_WIRE_KEY = 'cache_control';

interface PromptMessageLike {
  providerOptions?: Record<string, Record<string, unknown>>;
  role?: unknown;
}

interface PromptParamsLike {
  prompt?: readonly PromptMessageLike[];
}

function hasExplicitCacheControl(message: PromptMessageLike): boolean {
  const anthropicOptions = message.providerOptions?.[ANTHROPIC_NAMESPACE];
  if (!anthropicOptions) {
    return false;
  }
  return (
    anthropicOptions[CACHE_CONTROL_KEY] !== undefined ||
    anthropicOptions[CACHE_CONTROL_WIRE_KEY] !== undefined
  );
}

/**
 * Pure transform: returns new params whose final prompt message carries an
 * ephemeral Anthropic cache breakpoint. Never mutates its input; preserves
 * existing provider-option namespaces and any explicit cacheControl.
 */
export function applyAnthropicPromptCacheBreakpoint<T extends PromptParamsLike>(params: T): T {
  const prompt = params.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return params;
  }
  const last = prompt.at(-1) as PromptMessageLike;
  if (hasExplicitCacheControl(last)) {
    return params;
  }
  const decoratedLast: PromptMessageLike = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      [ANTHROPIC_NAMESPACE]: {
        ...last.providerOptions?.[ANTHROPIC_NAMESPACE],
        [CACHE_CONTROL_KEY]: { type: 'ephemeral' },
      },
    },
  };
  return { ...params, prompt: [...prompt.slice(0, -1), decoratedLast] };
}

type ModelCallMethod = (params: PromptParamsLike) => unknown;

const WRAPPED_CALL_METHODS = new Set(['doGenerate', 'doStream']);

/**
 * Wraps an AI SDK language model so every `doStream`/`doGenerate` call goes out
 * with the tail cache breakpoint applied. All other properties (spec version,
 * ids, capability probes) delegate to the wrapped model untouched.
 *
 * Two deliberate limits: non-wrapped methods are re-bound per property access
 * (method identity is not stable across reads — no known consumer compares
 * it), and any path that reconstructs the model from serialized config (e.g.
 * the SDK's workflow serialize/deserialize statics) yields an UNWRAPPED model.
 * Brainstrike always re-creates models through createProvider on resume, so
 * every live request path re-wraps.
 */
export function wrapAnthropicModelWithPromptCaching<M extends object>(model: M): M {
  return new Proxy(model, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property === 'string' && WRAPPED_CALL_METHODS.has(property)) {
        if (typeof value !== 'function') {
          return value;
        }
        const method = value as ModelCallMethod;
        return (params: PromptParamsLike) =>
          method.call(target, applyAnthropicPromptCacheBreakpoint(params));
      }
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
}
