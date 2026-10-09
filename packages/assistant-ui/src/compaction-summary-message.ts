import {
  COMPACTION_SUMMARY_METADATA_KEY,
  type CompactionSummaryPayload,
  isCompactionSummaryPayload,
} from '@brainstrike/assistant-contract/compaction-summary';

/** A host thread's committed `context.compacted`, as a data part of the run that made it. */
export const HOST_CONTEXT_COMPACTED_DATA_NAME = 'brainstrike.context-compacted';

export interface HostContextCompaction {
  readonly kind: CompactionSummaryPayload['fallbackKind'];
  readonly summary: string;
}

/** The committed projection writes this part; any other shape is a projection defect. */
export function readHostContextCompaction(data: unknown): HostContextCompaction {
  if (
    isRecord(data) &&
    (data['kind'] === 'agentic' || data['kind'] === 'deterministic') &&
    typeof data['summary'] === 'string'
  ) {
    return { kind: data['kind'], summary: data['summary'] };
  }
  throw new Error('Host compaction part has an unsupported shape.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * True when an ordinary durable assistant message carries a structurally valid
 * compaction-summary marker. The message remains model-visible; this recognizer
 * exists only so the renderer can choose its dedicated divider/card treatment.
 */
export function readCompactionSummaryPayload(message: unknown): CompactionSummaryPayload | null {
  if (!isRecord(message) || message['role'] !== 'assistant') {
    return null;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return null;
  }
  const custom = metadata['custom'];
  if (!isRecord(custom)) {
    return null;
  }
  const payload = custom[COMPACTION_SUMMARY_METADATA_KEY];
  return isCompactionSummaryPayload(payload) ? payload : null;
}

export function isCompactionSummaryMessage(message: unknown): boolean {
  return readCompactionSummaryPayload(message) !== null;
}
