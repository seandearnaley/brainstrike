import { describe, expect, it } from 'vitest';
import { ASSISTANT_RUN_USAGE_KINDS, isAssistantChildRunUsage } from '../run-usage';

describe('run-usage contract', () => {
  it('pins the attribution kinds (UI labels and the PGlite CHECK constraint derive from this)', () => {
    expect(ASSISTANT_RUN_USAGE_KINDS).toEqual([
      'chat',
      'subagent',
      'compaction-summary',
      'thread-title',
      'auto-review',
    ]);
  });

  it('accepts well-formed child usage with and without attribution fields', () => {
    expect(
      isAssistantChildRunUsage({
        inputTokens: 24_000,
        outputTokens: 900,
        source: 'thread-title',
      })
    ).toBe(true);
    expect(
      isAssistantChildRunUsage({
        inputTokens: 1200,
        model: 'gpt-5.2',
        outputTokens: 180,
        provider: 'openai',
        source: 'compaction-summary',
      })
    ).toBe(true);
    expect(
      isAssistantChildRunUsage({
        inputTokens: 42,
        model: 'gpt-5.2',
        outputTokens: 7,
        personaId: 'explore',
        provider: 'openai',
        source: 'subagent',
      })
    ).toBe(true);
  });

  it('retains complete native delegation identity and rejects partial or misclassified identity', () => {
    const delegation = {
      parentRuntimeRunId: 'parent',
      parentToolCallId: 'call',
      resourceId: 'resource',
      threadId: 'child',
    };
    const usage = {
      delegation,
      inputTokens: 2,
      outputTokens: 3,
      personaId: 'explore',
      source: 'subagent',
    };
    expect(isAssistantChildRunUsage(usage)).toBe(true);
    for (const key of Object.keys(delegation)) {
      expect(
        isAssistantChildRunUsage({ ...usage, delegation: { ...delegation, [key]: undefined } })
      ).toBe(false);
      expect(
        isAssistantChildRunUsage({ ...usage, delegation: { ...delegation, [key]: ' ' } })
      ).toBe(false);
    }
    expect(isAssistantChildRunUsage({ ...usage, source: 'thread-title' })).toBe(false);
  });

  it('rejects chat as a child source and malformed payloads (never coerced)', () => {
    expect(
      isAssistantChildRunUsage({
        inputTokens: 1,
        outputTokens: 1,
        source: 'chat',
      })
    ).toBe(false);
    expect(
      isAssistantChildRunUsage({
        inputTokens: -1,
        outputTokens: 1,
        source: 'auto-review',
      })
    ).toBe(false);
    expect(
      isAssistantChildRunUsage({
        inputTokens: Number.NaN,
        outputTokens: 0,
        source: 'thread-title',
      })
    ).toBe(false);
    expect(
      isAssistantChildRunUsage({
        inputTokens: 1,
        model: '',
        outputTokens: 1,
        source: 'thread-title',
      })
    ).toBe(false);
    expect(isAssistantChildRunUsage(null)).toBe(false);
    expect(isAssistantChildRunUsage([])).toBe(false);
  });
});
