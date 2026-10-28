/**
 * OpenRouter prompt caching for routes whose upstream needs explicit
 * breakpoints (Anthropic; OpenAI, Gemini, DeepSeek, Grok and the rest cache
 * automatically and declare no dialect).
 *
 * OpenRouter documents a single top-level `cache_control: {type: 'ephemeral'}`
 * request field as automatic caching for Anthropic: it places the breakpoint
 * on the last cacheable block and moves it forward as the conversation grows
 * (https://openrouter.ai/docs/features/prompt-caching). @openrouter/ai-sdk-provider
 * sends call-level `providerOptions.openrouter.cacheControl` as exactly that
 * field, so this wrapper sets the option and writes no breakpoints itself.
 *
 * Applied to routes whose registry row declares `promptCaching: 'openrouter'`,
 * selected in `prompt-caching.ts`.
 */

import { type ModelCallParamsLike, wrapModelWithCallTransform } from './prompt-transform-proxy.ts';

const OPENROUTER_NAMESPACE = 'openrouter';

/**
 * Pure transform: request-level ephemeral caching, unless the caller already
 * chose a cache control. Never mutates its input; keeps the other OpenRouter
 * options (reasoning, provider routing) beside it.
 */
export function applyOpenRouterAutomaticCaching<T extends ModelCallParamsLike>(params: T): T {
  const openrouter = params.providerOptions?.[OPENROUTER_NAMESPACE];
  if (openrouter?.['cacheControl'] !== undefined || openrouter?.['cache_control'] !== undefined) {
    return params;
  }
  return {
    ...params,
    providerOptions: {
      ...params.providerOptions,
      [OPENROUTER_NAMESPACE]: { ...openrouter, cacheControl: { type: 'ephemeral' } },
    },
  };
}

export function wrapOpenRouterModelWithPromptCaching<M extends object>(model: M): M {
  return wrapModelWithCallTransform(model, applyOpenRouterAutomaticCaching);
}
