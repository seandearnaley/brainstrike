/**
 * Conversation token estimator v2 (BST-940) — the client-side walk behind the
 * context usage meter.
 *
 * The v1 walk counted ONLY plain text parts, so coding threads (dominated by
 * tool args/results and reasoning) read absurdly low. This walk counts every
 * measurable part with the shared chars/4 heuristic and attributes tool tokens
 * per tool name for the popover's per-tool breakdown. Attachments are counted,
 * never token-faked (an image's provider token cost is model-specific).
 *
 * Per-message counts are memoized in a WeakMap keyed by the message object:
 * assistant-ui snapshots keep settled message identities stable and only the
 * streaming tail changes, so live re-walks during a run cost one message.
 */
import { countTokensHeuristic } from '@brainstrike/utils/token-counting-heuristics';
import { getMessageParts } from './assistant-run-timeline';

export interface ToolTokenAttribution {
  readonly name: string;
  readonly tokens: number;
}

export interface ConversationTokenEstimate {
  readonly assistantTextTokens: number;
  readonly attachmentsCount: number;
  /** Per-tool args+result tokens, sorted descending (name ties alphabetical). */
  readonly byTool: readonly ToolTokenAttribution[];
  readonly reasoningTokens: number;
  readonly toolTokens: number;
  /** Sum of every counted category (attachments contribute no tokens). */
  readonly totalTokens: number;
  readonly userTextTokens: number;
}

interface PerMessageCounts {
  assistantTextTokens: number;
  attachmentsCount: number;
  reasoningTokens: number;
  toolTokensByName: ReadonlyMap<string, number>;
  userTextTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    // Circular or otherwise unserializable — skip honestly (under-count)
    // rather than guessing a size.
    return;
  }
}

function countToolPart(part: Record<string, unknown>): { name: string; tokens: number } {
  const name = typeof part['toolName'] === 'string' && part['toolName'] ? part['toolName'] : 'tool';
  let tokens = 0;
  const argsText =
    typeof part['argsText'] === 'string' ? part['argsText'] : safeStringify(part['args']);
  if (argsText) {
    tokens += countTokensHeuristic(argsText);
  }
  const resultText = safeStringify(part['result']);
  if (resultText) {
    tokens += countTokensHeuristic(resultText);
  }
  return { name, tokens };
}

interface MutableMessageCounts {
  assistantTextTokens: number;
  attachmentsCount: number;
  reasoningTokens: number;
  userTextTokens: number;
}

function countTextLikePart(
  part: Record<string, unknown>,
  role: 'assistant' | 'user',
  counts: MutableMessageCounts
): void {
  if (typeof part['text'] !== 'string') {
    return;
  }
  const tokens = countTokensHeuristic(part['text']);
  if (part['type'] === 'reasoning') {
    counts.reasoningTokens += tokens;
  } else if (role === 'user') {
    counts.userTextTokens += tokens;
  } else {
    counts.assistantTextTokens += tokens;
  }
}

function accumulateToolPart(
  part: Record<string, unknown>,
  toolTokensByName: Map<string, number>
): void {
  const source =
    part['type'] === 'tool-invocation' && isRecord(part['toolInvocation'])
      ? part['toolInvocation']
      : part;
  const { name, tokens } = countToolPart(source);
  if (tokens > 0) {
    toolTokensByName.set(name, (toolTokensByName.get(name) ?? 0) + tokens);
  }
}

function countMessage(message: unknown): PerMessageCounts {
  const role = isRecord(message) && message['role'] === 'user' ? 'user' : 'assistant';
  const counts: MutableMessageCounts = {
    assistantTextTokens: 0,
    attachmentsCount: 0,
    reasoningTokens: 0,
    userTextTokens: 0,
  };
  const toolTokensByName = new Map<string, number>();
  for (const part of getMessageParts(message)) {
    if (!isRecord(part)) {
      continue;
    }
    const type = part['type'];
    if (type === 'text' || type === 'reasoning') {
      countTextLikePart(part, role, counts);
    } else if (type === 'tool-call' || type === 'tool-invocation') {
      accumulateToolPart(part, toolTokensByName);
    } else if (type === 'file' || type === 'image') {
      counts.attachmentsCount += 1;
    }
  }
  return { ...counts, toolTokensByName };
}

interface CachedMessageCounts {
  counts: PerMessageCounts;
  /** Parts-array fingerprint: a reused message whose parts array was swapped or grew re-counts. */
  partsLength: number;
  partsRef: readonly unknown[];
}

const messageCountCache = new WeakMap<object, CachedMessageCounts>();

/**
 * Memoized per-message count. The cache validates the parts ARRAY (reference +
 * length), not just the message identity — if assistant-ui ever reuses a
 * message object while appending parts, the entry invalidates instead of
 * freezing the count (review hardening). The caller additionally never
 * memoizes the streaming tail, whose latest text part can grow in place.
 */
function countMessageMemoized(message: unknown, cacheable: boolean): PerMessageCounts {
  if (!(cacheable && isRecord(message))) {
    return countMessage(message);
  }
  const parts = getMessageParts(message);
  const cached = messageCountCache.get(message);
  if (cached && cached.partsRef === parts && cached.partsLength === parts.length) {
    return cached.counts;
  }
  const counts = countMessage(message);
  messageCountCache.set(message, { counts, partsLength: parts.length, partsRef: parts });
  return counts;
}

/** Walk every message part and aggregate the estimate (heuristic, chars/4). */
export function estimateConversationTokens(
  messages: readonly unknown[]
): ConversationTokenEstimate {
  let assistantTextTokens = 0;
  let attachmentsCount = 0;
  let reasoningTokens = 0;
  let userTextTokens = 0;
  const toolTotals = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    // The final message is the potential streaming tail — always re-count it.
    const counts = countMessageMemoized(message, index < messages.length - 1);
    assistantTextTokens += counts.assistantTextTokens;
    attachmentsCount += counts.attachmentsCount;
    reasoningTokens += counts.reasoningTokens;
    userTextTokens += counts.userTextTokens;
    for (const [name, tokens] of counts.toolTokensByName) {
      toolTotals.set(name, (toolTotals.get(name) ?? 0) + tokens);
    }
  }
  const byTool = [...toolTotals.entries()]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
  const toolTokens = byTool.reduce((sum, entry) => sum + entry.tokens, 0);
  return {
    assistantTextTokens,
    attachmentsCount,
    byTool,
    reasoningTokens,
    toolTokens,
    totalTokens: assistantTextTokens + reasoningTokens + toolTokens + userTextTokens,
    userTextTokens,
  };
}

export interface DisplayedContextUsage {
  readonly isEstimated: boolean;
  readonly usedTokens: number;
}

/**
 * Pick the gauge's displayed figure. Idle with exact usage → exact (last
 * provider step, cache-inclusive). While a run streams → live estimate
 * (server breakdown baseline + conversation walk), floored at the last exact
 * figure so the gauge never shrinks mid-conversation, and honestly flagged
 * estimated. Before any exact usage → the estimate alone; an empty thread
 * shows an honest un-flagged zero.
 */
export function resolveDisplayedContextUsage(args: {
  /** System instructions + task list + tool definitions from the server breakdown (0 when absent). */
  breakdownBaselineTokens: number;
  conversationEstimateTokens: number;
  exact: { inputTokens: number; outputTokens: number } | undefined;
  isRunning: boolean;
}): DisplayedContextUsage {
  const exactTotal = args.exact ? args.exact.inputTokens + args.exact.outputTokens : undefined;
  const liveEstimate = args.breakdownBaselineTokens + args.conversationEstimateTokens;
  if (args.isRunning) {
    return { isEstimated: true, usedTokens: Math.max(liveEstimate, exactTotal ?? 0) };
  }
  if (exactTotal !== undefined) {
    return { isEstimated: false, usedTokens: exactTotal };
  }
  if (liveEstimate > 0) {
    return { isEstimated: true, usedTokens: liveEstimate };
  }
  return { isEstimated: false, usedTokens: 0 };
}
