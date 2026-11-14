// @vitest-environment node
import { COMPACTION_SUMMARY_METADATA_KEY } from '@brainstrike/assistant-contract/compaction-summary';
import { describe, expect, it } from 'vitest';
import {
  isCompactionSummaryMessage,
  readHostContextCompaction,
} from '../compaction-summary-message';

describe('readHostContextCompaction', () => {
  const lists = {
    earlierRequests: ['Move the port.'],
    filesEdited: [{ edits: 2, path: 'src/server.ts' }],
    toolsLoaded: ['brainstrike_lspInspect'],
  };
  const part = {
    ...lists,
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

  it('reads the summarizer failure a deterministic fallback recorded (BST-2204)', () => {
    const fallback = {
      ...lists,
      kind: 'deterministic',
      reason: 'pre-request',
      summarizerFailure: {
        code: 'provider.auth-failed',
        correlationId: '0b6a1f4e-6f1c-4d4b-9a51-2f0f6e0b9c11',
      },
      summary: 'Deterministic fallback: dropped 2 earlier turns.',
      turnsCompacted: 2,
    } as const;
    expect(readHostContextCompaction(fallback)).toEqual(fallback);
  });

  it('reads a compaction of a running turn’s steps, and a request trim (BST-2531)', () => {
    const steps = { ...part, stepsCompacted: 7, turnsCompacted: 0 };
    expect(readHostContextCompaction(steps)).toEqual(steps);
    const trim = {
      ...lists,
      kind: 'deterministic',
      reason: 'request-trim',
      summary: 'Dropped.',
      turnsCompacted: 1,
    };
    expect(readHostContextCompaction(trim)).toEqual(trim);
  });

  it.each([
    ['without its reason', { ...part, reason: undefined }],
    ['with no compacted turns', { ...part, turnsCompacted: 0 }],
    ['with no compacted steps', { ...part, stepsCompacted: 0, turnsCompacted: 0 }],
    ['with an empty summarizer model', { ...part, modelId: '' }],
    ['with usage missing its tokens', { ...part, usage: { inputTokens: 10 } }],
    ['with a summarizer failure missing its code', { ...part, summarizerFailure: {} }],
    ['without the host’s lists (BST-2527)', { ...part, toolsLoaded: undefined }],
    ['with a file of no edits', { ...part, filesEdited: [{ edits: 0, path: 'src/a.ts' }] }],
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
