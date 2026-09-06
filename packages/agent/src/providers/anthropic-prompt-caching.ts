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
 * The wrapper is applied to models whose registry row declares
 * `promptCaching: 'anthropic'` (every hosted Anthropic model does), selected in
 * `prompt-caching.ts`. Other providers never see the `anthropic` namespace.
 */

import {
  type PromptMessageLike,
  type PromptParamsLike,
  wrapModelWithPromptTransform,
} from './prompt-transform-proxy';

const ANTHROPIC_NAMESPACE = 'anthropic';
const CACHE_CONTROL_KEY = 'cacheControl';
/** Raw wire spelling also honored by @ai-sdk/anthropic's cache-control reader. */
const CACHE_CONTROL_WIRE_KEY = 'cache_control';

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

/**
 * Wraps an AI SDK language model so every `doStream`/`doGenerate` call goes out
 * with the tail cache breakpoint applied. See `prompt-transform-proxy.ts` for
 * the two documented limits of the wrapping technique.
 */
export function wrapAnthropicModelWithPromptCaching<M extends object>(model: M): M {
  return wrapModelWithPromptTransform(model, applyAnthropicPromptCacheBreakpoint);
}
