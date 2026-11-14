import {
  COMPACTION_SUMMARY_METADATA_KEY,
  type CompactionSummaryPayload,
  isCompactionSummaryPayload,
} from '@brainstrike/assistant-contract/compaction-summary';
import { Predicate } from 'effect';

/** A host thread's committed `context.compacted`, as a data part of the run that made it. */
export const HOST_CONTEXT_COMPACTED_DATA_NAME = 'brainstrike.context-compacted';

/**
 * Why the host compacted: before a request over its budget, after a provider
 * overflow, or because the provider request still left messages out (BST-2531).
 */
type HostContextCompactionReason = 'pre-request' | 'context-overflow' | 'request-trim';

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

/** A file the covered calls edited, and how many edits they made to it. */
interface HostContextCompactionFile {
  readonly edits: number;
  readonly path: string;
}

/**
 * The lists the host wrote from the log for everything the summary covers
 * (BST-2527): the person's requests, the files edited and the tools loaded.
 */
export interface HostContextCompactionLists {
  readonly earlierRequests: readonly string[];
  readonly filesEdited: readonly HostContextCompactionFile[];
  readonly toolsLoaded: readonly string[];
}

export interface HostContextCompaction extends HostContextCompactionLists {
  readonly kind: CompactionSummaryPayload['fallbackKind'];
  /** The summarizer's catalog model, when one ran. */
  readonly modelId?: string;
  readonly reason: HostContextCompactionReason;
  /**
   * The steps of a running turn the summary covers (its `through`, less the
   * steps kept word for word).
   */
  readonly stepsCompacted?: number;
  readonly summarizerFailure?: HostContextSummarizerFailure;
  /** The model's sections, or a fallback's line. */
  readonly summary: string;
  /** The earlier turns the summary covers (its `compactedRunIds`). */
  readonly turnsCompacted: number;
  readonly usage?: HostContextCompactionUsage;
}

function isReason(value: unknown): value is HostContextCompactionReason {
  return value === 'pre-request' || value === 'context-overflow' || value === 'request-trim';
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
 * How many steps of a running turn a compaction's summary covers, from its
 * `through`: up to its step, less every step its run kept word for word
 * (BST-2527). Or why that cannot be read. The one reader of `through` here.
 */
function readStepsCovered(value: unknown): number {
  const kept = Predicate.isObject(value) ? (value['kept'] ?? []) : undefined;
  if (
    Predicate.isObject(value) &&
    isText(value['runId']) &&
    isCount(value['stepNumber']) &&
    Array.isArray(kept) &&
    kept.every(isCount)
  ) {
    return value['stepNumber'] + 1 - kept.length;
  }
  throw new Error('Committed compaction has an unreadable step.');
}

function isFile(value: unknown): value is HostContextCompactionFile {
  return (
    Predicate.isObject(value) &&
    isText(value['path']) &&
    isCount(value['edits']) &&
    value['edits'] > 0
  );
}

/** The host-written lists, as committed and as the part carries them, or why they cannot be read. */
function readLists(value: Readonly<Record<string, unknown>>): HostContextCompactionLists {
  const { earlierRequests, filesEdited, toolsLoaded } = value;
  if (
    Array.isArray(earlierRequests) &&
    earlierRequests.every((request) => typeof request === 'string') &&
    Array.isArray(filesEdited) &&
    filesEdited.every(isFile) &&
    Array.isArray(toolsLoaded) &&
    toolsLoaded.every(isText)
  ) {
    return {
      earlierRequests,
      filesEdited: filesEdited.map(({ edits, path }) => ({ edits, path })),
      toolsLoaded,
    };
  }
  throw new Error('Committed compaction has unreadable lists.');
}

/**
 * A committed `context.compacted` event as its card part: the reason, the
 * turns and steps its summary covers, the host's lists, and the summarizer's
 * model and usage when one ran. A thread carries one current summary, so each
 * card counts all it covers (BST-2527).
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
  const steps = event['through'] === undefined ? undefined : readStepsCovered(event['through']);
  if (
    !Array.isArray(compactedRunIds) ||
    (compactedRunIds.length === 0 && steps === undefined) ||
    !compactedRunIds.every((runId) => typeof runId === 'string' && runId)
  ) {
    throw new Error('Committed compaction names no compacted runs.');
  }
  if (modelId !== undefined && !(typeof modelId === 'string' && modelId)) {
    throw new Error('Committed compaction has an unreadable summarizer model.');
  }
  return {
    ...readLists(event),
    kind,
    ...(modelId === undefined ? {} : { modelId }),
    reason,
    ...(steps === undefined ? {} : { stepsCompacted: steps }),
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
  const steps = Predicate.isObject(data) ? data['stepsCompacted'] : undefined;
  if (
    Predicate.isObject(data) &&
    (data['kind'] === 'agentic' || data['kind'] === 'deterministic') &&
    typeof data['summary'] === 'string' &&
    isReason(data['reason']) &&
    isCount(data['turnsCompacted']) &&
    (steps === undefined || isCount(steps)) &&
    data['turnsCompacted'] + (steps ?? 0) > 0 &&
    (data['modelId'] === undefined || (typeof data['modelId'] === 'string' && data['modelId']))
  ) {
    return {
      ...readLists(data),
      kind: data['kind'],
      ...(data['modelId'] === undefined ? {} : { modelId: data['modelId'] }),
      reason: data['reason'],
      ...(steps === undefined ? {} : { stepsCompacted: steps }),
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
