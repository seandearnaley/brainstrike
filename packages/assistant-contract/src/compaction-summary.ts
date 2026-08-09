export const COMPACTION_SUMMARY_METADATA_KEY = 'brainstrikeCompactionSummary';

export interface CompactionSummaryPayload {
  readonly createdAt: string;
  readonly droppedSummaryLine?: string;
  readonly fallbackKind: 'agentic' | 'deterministic';
  readonly firstCompactedMessageId: string;
  readonly lastCompactedMessageId: string;
  readonly rewriteId: string;
}

const COMPACTION_SUMMARY_PAYLOAD_KEYS = new Set<PropertyKey>([
  'createdAt',
  'droppedSummaryLine',
  'fallbackKind',
  'firstCompactedMessageId',
  'lastCompactedMessageId',
  'rewriteId',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Strict recognizer for the durable compaction-summary metadata marker. */
export function isCompactionSummaryPayload(value: unknown): value is CompactionSummaryPayload {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).every((key) => COMPACTION_SUMMARY_PAYLOAD_KEYS.has(key)) &&
    Object.hasOwn(value, 'createdAt') &&
    Object.hasOwn(value, 'fallbackKind') &&
    Object.hasOwn(value, 'firstCompactedMessageId') &&
    Object.hasOwn(value, 'lastCompactedMessageId') &&
    Object.hasOwn(value, 'rewriteId') &&
    isNonEmptyString(value['createdAt']) &&
    (value['fallbackKind'] === 'agentic' || value['fallbackKind'] === 'deterministic') &&
    isNonEmptyString(value['firstCompactedMessageId']) &&
    isNonEmptyString(value['lastCompactedMessageId']) &&
    isNonEmptyString(value['rewriteId']) &&
    (!('droppedSummaryLine' in value) ||
      (Object.hasOwn(value, 'droppedSummaryLine') &&
        typeof value['droppedSummaryLine'] === 'string'))
  );
}
