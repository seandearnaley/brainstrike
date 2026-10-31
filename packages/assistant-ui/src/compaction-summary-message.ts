import {
  COMPACTION_SUMMARY_METADATA_KEY,
  type CompactionSummaryPayload,
  isCompactionSummaryPayload,
} from '@brainstrike/assistant-contract/compaction-summary';
import { Predicate } from 'effect';

/** A host thread's committed `context.compacted`, as a data part of the run that made it. */
export const HOST_CONTEXT_COMPACTED_DATA_NAME = 'brainstrike.context-compacted';

/** Why the host compacted: before a request over its budget, or after a provider overflow. */
type HostContextCompactionReason = 'pre-request' | 'context-overflow';

/** A summarizer side call's provider-reported tokens. */
interface HostContextCompactionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Why a deterministic fallback replaced the agentic summary (BST-2204). */
interface HostContextSummarizerFailure {
  /** The summarizer's typed failure code. */
  readonly code: string;
  /** The reference its cause is logged under in the diagnostic log. */
  readonly correlationId?: string;
}

export interface HostContextCompaction {
  readonly kind: CompactionSummaryPayload['fallbackKind'];
  /** The summarizer's catalog model, when one ran. */
  readonly modelId?: string;
  readonly reason: HostContextCompactionReason;
  readonly summarizerFailure?: HostContextSummarizerFailure;
  readonly summary: string;
  /** The earlier turns the compaction replaced (its `compactedRunIds`). */
  readonly turnsCompacted: number;
  readonly usage?: HostContextCompactionUsage;
}

function isReason(value: unknown): value is HostContextCompactionReason {
  return value === 'pre-request' || value === 'context-overflow';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A recorded summarizer failure, or why it cannot be read. */
function readSummarizerFailure(value: unknown): HostContextSummarizerFailure {
  if (
    Predicate.isObject(value) &&
    isText(value['code']) &&
    (value['correlationId'] === undefined || isText(value['correlationId']))
  ) {
    return {
      code: value['code'],
      ...(value['correlationId'] === undefined ? {} : { correlationId: value['correlationId'] }),
    };
  }
  throw new Error('Committed compaction has an unreadable summarizer failure.');
}

/** A summarizer's usage as committed (the SDK's totalUsage), or why it cannot be read. */
function readHostCompactionUsage(usage: unknown): HostContextCompactionUsage {
  if (
    Predicate.isObject(usage) &&
    isCount(usage['inputTokens']) &&
    isCount(usage['outputTokens'])
  ) {
    return { inputTokens: usage['inputTokens'], outputTokens: usage['outputTokens'] };
  }
  throw new Error('Committed compaction usage has no provider-reported token counts.');
}

/**
 * A committed `context.compacted` event as its card part: the reason, the
 * turns it replaced, and the summarizer's model and usage when one ran.
 */
export function committedHostCompaction(
  event: Readonly<Record<string, unknown>>
): HostContextCompaction {
  const { compactedRunIds, kind, modelId, reason, summarizerFailure, summary, usage } = event;
  if (kind !== 'agentic' && kind !== 'deterministic') {
    throw new Error('Committed compaction has an unsupported kind.');
  }
  if (!isReason(reason)) {
    throw new Error('Committed compaction has an unsupported reason.');
  }
  if (typeof summary !== 'string' || !summary) {
    throw new Error('Committed compaction is missing summary.');
  }
  if (
    !Array.isArray(compactedRunIds) ||
    compactedRunIds.length === 0 ||
    !compactedRunIds.every((runId) => typeof runId === 'string' && runId)
  ) {
    throw new Error('Committed compaction names no compacted runs.');
  }
  if (modelId !== undefined && !(typeof modelId === 'string' && modelId)) {
    throw new Error('Committed compaction has an unreadable summarizer model.');
  }
  return {
    kind,
    ...(modelId === undefined ? {} : { modelId }),
    reason,
    ...(summarizerFailure === undefined
      ? {}
      : { summarizerFailure: readSummarizerFailure(summarizerFailure) }),
    summary,
    turnsCompacted: compactedRunIds.length,
    ...(usage === undefined ? {} : { usage: readHostCompactionUsage(usage) }),
  };
}

/** The committed projection writes this part; any other shape is a projection defect. */
export function readHostContextCompaction(data: unknown): HostContextCompaction {
  if (
    Predicate.isObject(data) &&
    (data['kind'] === 'agentic' || data['kind'] === 'deterministic') &&
    typeof data['summary'] === 'string' &&
    isReason(data['reason']) &&
    isCount(data['turnsCompacted']) &&
    data['turnsCompacted'] > 0 &&
    (data['modelId'] === undefined || (typeof data['modelId'] === 'string' && data['modelId']))
  ) {
    return {
      kind: data['kind'],
      ...(data['modelId'] === undefined ? {} : { modelId: data['modelId'] }),
      reason: data['reason'],
      ...(data['summarizerFailure'] === undefined
        ? {}
        : { summarizerFailure: readSummarizerFailure(data['summarizerFailure']) }),
      summary: data['summary'],
      turnsCompacted: data['turnsCompacted'],
      ...(data['usage'] === undefined ? {} : { usage: readHostCompactionUsage(data['usage']) }),
    };
  }
  throw new Error('Host compaction part has an unsupported shape.');
}

/**
 * True when an ordinary durable assistant message carries a structurally valid
 * compaction-summary marker. The message remains model-visible; this recognizer
 * exists only so the renderer can choose its dedicated divider/card treatment.
 */
export function readCompactionSummaryPayload(message: unknown): CompactionSummaryPayload | null {
  if (!Predicate.isObject(message) || message['role'] !== 'assistant') {
    return null;
  }
  const metadata = message['metadata'];
  if (!Predicate.isObject(metadata)) {
    return null;
  }
  const custom = metadata['custom'];
  if (!Predicate.isObject(custom)) {
    return null;
  }
  const payload = custom[COMPACTION_SUMMARY_METADATA_KEY];
  return isCompactionSummaryPayload(payload) ? payload : null;
}

export function isCompactionSummaryMessage(message: unknown): boolean {
  return readCompactionSummaryPayload(message) !== null;
}
