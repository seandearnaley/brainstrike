// @vitest-environment node
import { COMPACTION_SUMMARY_METADATA_KEY } from '@brainstrike/assistant-contract/compaction-summary';
import { describe, expect, it } from 'vitest';
import { isCompactionSummaryMessage } from '../compaction-summary-message';

const payload = {
  createdAt: '2026-08-09T12:00:00.000Z',
  fallbackKind: 'agentic',
  firstCompactedMessageId: 'message-first',
  lastCompactedMessageId: 'message-last',
  rewriteId: 'rewrite-1',
} as const;

function message(marker: unknown = payload): unknown {
  return {
    metadata: { custom: { [COMPACTION_SUMMARY_METADATA_KEY]: marker } },
    role: 'assistant',
  };
}

describe('isCompactionSummaryMessage', () => {
  it('recognizes an assistant message carrying a valid summary marker', () => {
    expect(isCompactionSummaryMessage(message())).toBe(true);
  });

  it('rejects a missing marker and a marker on the wrong role', () => {
    expect(isCompactionSummaryMessage({ metadata: { custom: {} }, role: 'assistant' })).toBe(false);
    expect(isCompactionSummaryMessage({ ...(message() as object), role: 'user' })).toBe(false);
  });

  it('does not recognize a record-but-structurally-invalid marker', () => {
    expect(isCompactionSummaryMessage(message({}))).toBe(false);
  });
});
