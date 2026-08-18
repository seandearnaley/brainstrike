/**
 * Amazon Bedrock prompt caching (BST-1354).
 *
 * Bedrock's Converse API does not cache a prefix implicitly: a request carries
 * explicit `cachePoint` checkpoints, and everything ABOVE the highest matching
 * checkpoint is served from cache. Without them an agentic Bedrock run re-pays
 * full input price for the system prompt, tool schemas and entire history on
 * every step — the ~10x cost gap BST-1350 recorded against first-party
 * Anthropic, which has had breakpoints since BST-587.
 *
 * PLACEMENT: the first two system messages plus the last two non-system
 * messages, matching OpenCode's policy. Two at the tail (rather than one) keeps
 * a checkpoint on the PREVIOUS turn's boundary while the current turn extends
 * past it, so step N+1 still reads step N's prefix instead of only rewriting
 * it. AWS caps a request at FOUR checkpoints, which this policy exactly
 * saturates and can never exceed — a message that is both "first two system"
 * and "last two non-system" is impossible, and the two selections are unioned
 * by index so a short prompt cannot double-mark one message.
 *
 * Breakpoints below the model's minimum cacheable length (1,024 tokens for most
 * routes, 4,096 for the newest Claude tier) are ignored server-side. That is
 * documented API behavior, not a client-side fallback.
 *
 * MESSAGE level, not content-part level: `@ai-sdk/amazon-bedrock` reads
 * `message.providerOptions` for system, user and assistant messages alike,
 * whereas part-level metadata is only consulted for some part kinds. Message
 * level is therefore the one placement that behaves identically for every role.
 */

/** The namespace we WRITE. */
const BEDROCK_NAMESPACE = 'bedrock';
/**
 * The SDK resolves `providerMetadata.amazonBedrock.cachePoint` in preference to
 * `providerMetadata.bedrock.cachePoint`. An explicit breakpoint under either
 * spelling is authoritative, so both are checked before we add our own —
 * otherwise a caller-supplied checkpoint would be silently doubled and burn one
 * of the four the request is allowed.
 */
const BEDROCK_ALIAS_NAMESPACE = 'amazonBedrock';
const CACHE_POINT_KEY = 'cachePoint';
const SYSTEM_ROLE = 'system';
/** AWS allows four checkpoints per request; this policy spends all four. */
const SYSTEM_CACHE_POINTS = 2;
const TAIL_CACHE_POINTS = 2;

interface PromptMessageLike {
  providerOptions?: Record<string, Record<string, unknown>>;
  role?: unknown;
}

interface PromptParamsLike {
  prompt?: readonly PromptMessageLike[];
}

function hasExplicitCachePoint(message: PromptMessageLike): boolean {
  const options = message.providerOptions;
  if (!options) {
    return false;
  }
  return (
    options[BEDROCK_NAMESPACE]?.[CACHE_POINT_KEY] !== undefined ||
    options[BEDROCK_ALIAS_NAMESPACE]?.[CACHE_POINT_KEY] !== undefined
  );
}

/**
 * Indices to mark: the first `SYSTEM_CACHE_POINTS` system messages and the last
 * `TAIL_CACHE_POINTS` non-system messages, unioned so no index is marked twice.
 */
function selectCacheBreakpointIndices(prompt: readonly PromptMessageLike[]): ReadonlySet<number> {
  const systemIndices: number[] = [];
  const nonSystemIndices: number[] = [];
  for (const [index, message] of prompt.entries()) {
    if (message.role === SYSTEM_ROLE) {
      systemIndices.push(index);
      continue;
    }
    nonSystemIndices.push(index);
  }
  return new Set([
    ...systemIndices.slice(0, SYSTEM_CACHE_POINTS),
    ...nonSystemIndices.slice(-TAIL_CACHE_POINTS),
  ]);
}

/**
 * Pure transform: returns new params whose selected prompt messages carry a
 * Bedrock cache checkpoint. Never mutates its input; preserves existing
 * provider-option namespaces and any explicit `cachePoint`.
 */
export function applyBedrockPromptCacheBreakpoints<T extends PromptParamsLike>(params: T): T {
  const prompt = params.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return params;
  }
  const targets = selectCacheBreakpointIndices(prompt);
  let changed = false;
  const decorated = prompt.map((message: PromptMessageLike, index: number) => {
    if (!targets.has(index) || hasExplicitCachePoint(message)) {
      return message;
    }
    changed = true;
    return {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        [BEDROCK_NAMESPACE]: {
          ...message.providerOptions?.[BEDROCK_NAMESPACE],
          [CACHE_POINT_KEY]: { type: 'default' },
        },
      },
    };
  });
  if (!changed) {
    return params;
  }
  return { ...params, prompt: decorated };
}

type ModelCallMethod = (params: PromptParamsLike) => unknown;

const WRAPPED_CALL_METHODS = new Set(['doGenerate', 'doStream']);

/**
 * Wraps an AI SDK language model so every `doStream`/`doGenerate` call goes out
 * with Bedrock cache checkpoints applied. All other properties (spec version,
 * ids, capability probes) delegate to the wrapped model untouched.
 *
 * Carries the SAME two deliberate limits as the Anthropic wrapper it mirrors:
 * non-wrapped methods are re-bound per property access (method identity is not
 * stable across reads — no known consumer compares it), and any path that
 * reconstructs the model from serialized config (e.g. the SDK's workflow
 * serialize/deserialize statics) yields an UNWRAPPED model. Brainstrike always
 * re-creates models through createProvider on resume, so every live request
 * path re-wraps.
 */
export function wrapBedrockModelWithPromptCaching<M extends object>(model: M): M {
  return new Proxy(model, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property === 'string' && WRAPPED_CALL_METHODS.has(property)) {
        if (typeof value !== 'function') {
          return value;
        }
        const method = value as ModelCallMethod;
        return (params: PromptParamsLike) =>
          method.call(target, applyBedrockPromptCacheBreakpoints(params));
      }
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
}
