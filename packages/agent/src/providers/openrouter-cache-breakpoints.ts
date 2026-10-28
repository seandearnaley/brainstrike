/**
 * OpenRouter prompt caching for routes whose upstream caches only at explicit
 * content-block breakpoints (Alibaba-served Qwen).
 *
 * OpenRouter documents that "Alibaba prompt caching requires explicit cache
 * breakpoints": a `cache_control: {type: 'ephemeral'}` on a content block,
 * with no request-level form (https://openrouter.ai/docs/features/prompt-caching).
 * The request-level field the `openrouter` dialect sends is Anthropic-only, so
 * these routes need the breakpoints themselves.
 *
 * PLACEMENT: the first system message plus the last two user messages. The
 * system block caches the stable prefix; two user boundaries keep the previous
 * turn's breakpoint in place while the current turn grows past it, so the next
 * turn still reads it back.
 *
 * Breakpoints go on SYSTEM and USER messages only. @openrouter/ai-sdk-provider
 * turns a message-level `providerOptions.openrouter.cacheControl` on those two
 * roles into a block-level `cache_control` on their (last) text part, which is
 * the documented shape. On assistant and tool messages it writes a
 * message-level field instead, which the doc does not describe for Alibaba.
 *
 * Applied to routes whose registry row declares
 * `promptCaching: 'openrouter-breakpoints'`, selected in `prompt-caching.ts`.
 */

import {
  type PromptMessageLike,
  type PromptParamsLike,
  wrapModelWithPromptTransform,
} from './prompt-transform-proxy.ts';

/** Namespaces @openrouter/ai-sdk-provider reads a cache control from. */
const CACHE_CONTROL_NAMESPACES = ['openrouter', 'anthropic'] as const;
const OPENROUTER_NAMESPACE = 'openrouter';
const SYSTEM_ROLE = 'system';
const USER_ROLE = 'user';
const USER_BREAKPOINTS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasCacheControl(options: unknown): boolean {
  if (!isRecord(options)) {
    return false;
  }
  return CACHE_CONTROL_NAMESPACES.some((namespace) => {
    const scoped = options[namespace];
    return isRecord(scoped) && (scoped['cacheControl'] ?? scoped['cache_control']) !== undefined;
  });
}

/** A caller's own breakpoint, on the message or any of its parts, is left alone. */
function hasExplicitBreakpoint(message: PromptMessageLike): boolean {
  if (hasCacheControl(message.providerOptions)) {
    return true;
  }
  return (
    Array.isArray(message.content) &&
    message.content.some((part) => isRecord(part) && hasCacheControl(part['providerOptions']))
  );
}

function selectBreakpoints(prompt: readonly PromptMessageLike[]): ReadonlySet<number> {
  const targets = new Set<number>();
  const firstSystem = prompt.findIndex((message) => message.role === SYSTEM_ROLE);
  if (firstSystem !== -1) {
    targets.add(firstSystem);
  }
  const userIndices = prompt.flatMap((message, index) =>
    message.role === USER_ROLE ? [index] : []
  );
  for (const index of userIndices.slice(-USER_BREAKPOINTS)) {
    targets.add(index);
  }
  return targets;
}

/**
 * Pure transform: returns new params whose first system message and last two
 * user messages carry an ephemeral OpenRouter cache breakpoint. Never mutates
 * its input; a message that already carries a cache control keeps it.
 */
export function applyOpenRouterCacheBreakpoints<T extends PromptParamsLike>(params: T): T {
  const prompt = params.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return params;
  }
  const targets = selectBreakpoints(prompt);
  if (targets.size === 0) {
    return params;
  }
  const decorated = prompt.map((message: PromptMessageLike, index: number) => {
    if (!targets.has(index) || hasExplicitBreakpoint(message)) {
      return message;
    }
    return {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        [OPENROUTER_NAMESPACE]: {
          ...message.providerOptions?.[OPENROUTER_NAMESPACE],
          cacheControl: { type: 'ephemeral' },
        },
      },
    };
  });
  return { ...params, prompt: decorated };
}

export function wrapOpenRouterModelWithCacheBreakpoints<M extends object>(model: M): M {
  return wrapModelWithPromptTransform(model, applyOpenRouterCacheBreakpoints);
}
