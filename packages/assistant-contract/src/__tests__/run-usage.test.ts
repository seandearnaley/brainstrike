import { describe, expect, it } from 'vitest';
import { ASSISTANT_RUN_USAGE_KINDS, isAssistantChildRunUsage } from '../run-usage';

describe('run-usage contract', () => {
  it('pins the attribution kinds (DB CHECK constraint + UI labels derive from this)', () => {
    expect(ASSISTANT_RUN_USAGE_KINDS).toEqual([
      'chat',
      'subagent',
      'om-observation',
      'om-reflection',
    ]);
  });

  it('accepts well-formed child usage with and without attribution fields', () => {
    expect(
      isAssistantChildRunUsage({
        estimated: true,
        inputTokens: 24_000,
        outputTokens: 900,
        source: 'om-observation',
      })
    ).toBe(true);
    expect(
      isAssistantChildRunUsage({
        estimated: false,
        inputTokens: 42,
        model: 'gpt-5.2',
        outputTokens: 7,
        personaId: 'explore',
        provider: 'openai',
        source: 'subagent',
      })
    ).toBe(true);
  });

  it('rejects chat as a child source and malformed payloads (never coerced)', () => {
    expect(
      isAssistantChildRunUsage({
        estimated: false,
        inputTokens: 1,
        outputTokens: 1,
        source: 'chat',
      })
    ).toBe(false);
    expect(
      isAssistantChildRunUsage({
        estimated: true,
        inputTokens: -1,
        outputTokens: 1,
        source: 'om-reflection',
      })
    ).toBe(false);
    expect(
      isAssistantChildRunUsage({
        estimated: true,
        inputTokens: Number.NaN,
        outputTokens: 0,
        source: 'om-observation',
      })
    ).toBe(false);
    expect(
      isAssistantChildRunUsage({
        estimated: true,
        inputTokens: 1,
        model: '',
        outputTokens: 1,
        source: 'om-observation',
      })
    ).toBe(false);
    expect(isAssistantChildRunUsage(null)).toBe(false);
    expect(isAssistantChildRunUsage([])).toBe(false);
  });
});
