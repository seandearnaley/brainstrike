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
 * it.
 *
 * CEILING: AWS allows at most FOUR checkpoints per request and rejects a
 * request carrying more. Our four placements saturate that budget on their own,
 * so any EXPLICIT checkpoint the caller already set — at message level or on a
 * content part, under either the `bedrock` or `amazonBedrock` spelling — must
 * both suppress our placement on that message AND consume budget globally.
 * When the budget runs short we drop our own placements lowest-priority-first
 * (see `PLACEMENT_PRIORITY`); a caller's explicit checkpoint is never dropped,
 * because it is not ours to overrule.
 *
 * Breakpoints below the model's minimum cacheable length (1,024 tokens for most
 * routes, 4,096 for the newest Claude tier) are ignored server-side. That is
 * documented API behavior, not a client-side fallback.
 *
 * MESSAGE level, not content-part level, for the points we ADD:
 * `@ai-sdk/amazon-bedrock` reads `message.providerOptions` for system, user and
 * assistant messages alike, whereas part-level metadata is only consulted for
 * some part kinds. Message level is the one placement that behaves identically
 * for every role. We still READ part-level points, because the SDK honors
 * those when a caller sets them.
 */
import {
  type PromptMessageLike,
  type PromptParamsLike,
  wrapModelWithPromptTransform,
} from './prompt-transform-proxy';

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
/** AWS's hard per-request limit; exceeding it is a request-level rejection. */
const MAX_CACHE_POINTS = 4;
const SYSTEM_CACHE_POINTS = 2;
const TAIL_CACHE_POINTS = 2;

function hasCachePointInOptions(
  options: Record<string, Record<string, unknown>> | undefined
): boolean {
  if (!options) {
    return false;
  }
  return (
    options[BEDROCK_NAMESPACE]?.[CACHE_POINT_KEY] !== undefined ||
    options[BEDROCK_ALIAS_NAMESPACE]?.[CACHE_POINT_KEY] !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Whether the caller already placed a checkpoint on this message, at EITHER
 * level. Part-level points are real checkpoints to the SDK, so a message
 * carrying one is already spoken for.
 */
function hasExplicitCachePoint(message: PromptMessageLike): boolean {
  if (hasCachePointInOptions(message.providerOptions)) {
    return true;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((part) => {
    if (!isRecord(part)) {
      return false;
    }
    const partOptions = part['providerOptions'];
    return isRecord(partOptions)
      ? hasCachePointInOptions(partOptions as Record<string, Record<string, unknown>>)
      : false;
  });
}

/**
 * Our placements, most valuable first — the order we GIVE UP in reverse.
 *
 * System blocks rank highest: they cache the largest prefix and that prefix is
 * stable across every turn of the thread. Between the two tail placements the
 * LAST message matters more, because it is the boundary the next step reads
 * back; the second-to-last is the one that becomes redundant soonest, so it is
 * the first thing we surrender when a caller's explicit points crowd us out.
 */
const PLACEMENT_PRIORITY = ['system-0', 'system-1', 'tail-last', 'tail-previous'] as const;
type PlacementSlot = (typeof PLACEMENT_PRIORITY)[number];

/**
 * Indices we would like to mark, keyed by priority slot. A message that is
 * already explicitly checkpointed never appears here.
 */
function selectCandidatePlacements(
  prompt: readonly PromptMessageLike[]
): ReadonlyMap<PlacementSlot, number> {
  const systemIndices: number[] = [];
  const nonSystemIndices: number[] = [];
  for (const [index, message] of prompt.entries()) {
    if (hasExplicitCachePoint(message)) {
      continue;
    }
    if (message.role === SYSTEM_ROLE) {
      systemIndices.push(index);
      continue;
    }
    nonSystemIndices.push(index);
  }
  const systems = systemIndices.slice(0, SYSTEM_CACHE_POINTS);
  const tail = nonSystemIndices.slice(-TAIL_CACHE_POINTS);
  const candidates = new Map<PlacementSlot, number>();
  if (systems[0] !== undefined) {
    candidates.set('system-0', systems[0]);
  }
  if (systems[1] !== undefined) {
    candidates.set('system-1', systems[1]);
  }
  // `tail` holds at most two entries in prompt order, so the LAST element is
  // the newest boundary regardless of how many there are.
  const last = tail.at(-1);
  if (last !== undefined) {
    candidates.set('tail-last', last);
  }
  if (tail.length === TAIL_CACHE_POINTS && tail[0] !== undefined) {
    candidates.set('tail-previous', tail[0]);
  }
  return candidates;
}

/**
 * Pure transform: returns new params whose selected prompt messages carry a
 * Bedrock cache checkpoint. Never mutates its input; preserves existing
 * provider-option namespaces, honors explicit checkpoints, and never lets the
 * request exceed AWS's four-checkpoint ceiling.
 */
export function applyBedrockPromptCacheBreakpoints<T extends PromptParamsLike>(params: T): T {
  const prompt = params.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return params;
  }
  const explicitCount = prompt.filter((message) => hasExplicitCachePoint(message)).length;
  const budget = MAX_CACHE_POINTS - explicitCount;
  if (budget <= 0) {
    return params;
  }
  const candidates = selectCandidatePlacements(prompt);
  const targets = new Set<number>();
  for (const slot of PLACEMENT_PRIORITY) {
    if (targets.size >= budget) {
      break;
    }
    const index = candidates.get(slot);
    if (index !== undefined) {
      targets.add(index);
    }
  }
  if (targets.size === 0) {
    return params;
  }
  const decorated = prompt.map((message: PromptMessageLike, index: number) => {
    if (!targets.has(index)) {
      return message;
    }
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
  return { ...params, prompt: decorated };
}

/**
 * Wraps an AI SDK language model so every `doStream`/`doGenerate` call goes out
 * with Bedrock cache checkpoints applied. See `prompt-transform-proxy.ts` for
 * the two documented limits of the wrapping technique.
 */
export function wrapBedrockModelWithPromptCaching<M extends object>(model: M): M {
  return wrapModelWithPromptTransform(model, applyBedrockPromptCacheBreakpoints);
}
