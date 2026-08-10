import { describe, expect, it } from 'vitest';
import { COMPACTION_SUMMARY_METADATA_KEY, isCompactionSummaryPayload } from '../compaction-summary';

const validPayload = {
  createdAt: '2026-08-09T12:00:00.000Z',
  fallbackKind: 'agentic',
  firstCompactedMessageId: 'message-first',
  lastCompactedMessageId: 'message-last',
  rewriteId: 'rewrite-1',
} as const;

describe('isCompactionSummaryPayload', () => {
  it('accepts both compaction kinds and the optional dropped-summary line', () => {
    expect(isCompactionSummaryPayload(validPayload)).toBe(true);
    expect(
      isCompactionSummaryPayload({
        ...validPayload,
        droppedSummaryLine: 'Dropped 12 messages from August 1–3.',
        fallbackKind: 'deterministic',
      })
    ).toBe(true);
    expect(COMPACTION_SUMMARY_METADATA_KEY).toBe('brainstrikeCompactionSummary');
  });

  it.each([
    {},
    { ...validPayload, rewriteId: '' },
    { ...validPayload, fallbackKind: 'other' },
    { ...validPayload, firstCompactedMessageId: '   ' },
    { ...validPayload, droppedSummaryLine: 42 },
    { ...validPayload, extra: true },
  ])('rejects malformed or non-exact payloads: %j', (payload) => {
    expect(isCompactionSummaryPayload(payload)).toBe(false);
  });
});
