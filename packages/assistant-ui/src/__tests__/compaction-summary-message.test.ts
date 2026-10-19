// @vitest-environment node
import { COMPACTION_SUMMARY_METADATA_KEY } from '@brainstrike/assistant-contract/compaction-summary';
import { describe, expect, it } from 'vitest';
import {
  isCompactionSummaryMessage,
  readHostContextCompaction,
} from '../compaction-summary-message';

describe('readHostContextCompaction', () => {
  const part = {
    kind: 'agentic',
    modelId: 'openai::gpt-6-sol',
    reason: 'pre-request',
    summary: '## Goal',
    turnsCompacted: 2,
    usage: { inputTokens: 10, outputTokens: 2 },
  } as const;

  it('reads the card part the committed projection writes', () => {
    expect(readHostContextCompaction(part)).toEqual(part);
  });

  it.each([
    ['without its reason', { ...part, reason: undefined }],
    ['with no compacted turns', { ...part, turnsCompacted: 0 }],
    ['with an empty summarizer model', { ...part, modelId: '' }],
    ['with usage missing its tokens', { ...part, usage: { inputTokens: 10 } }],
  ])('refuses a part %s', (_label, data) => {
    expect(() => readHostContextCompaction(data)).toThrow(Error);
  });
});

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
