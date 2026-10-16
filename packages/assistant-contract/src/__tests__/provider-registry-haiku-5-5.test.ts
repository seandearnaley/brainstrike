import { describe, expect, it } from 'vitest';
import { getLlmModelDefinition, resolveDefaultModel } from '../provider-registry.js';

/**
 * Claude Haiku 5.5, sources retrieved 2026-10-16 (models overview, pricing,
 * effort and tool search pages). The row is pinned exhaustively so it cannot
 * gain a field by accident; each value's provenance is in its `_note`.
 */
describe('Claude Haiku 5.5 catalog row', () => {
  it('declares Claude Haiku 5.5 from the vendor pages: adaptive thinking, medium default, 1M context', () => {
    const { catalog, ...facts } = getLlmModelDefinition('anthropic', 'claude-haiku-5-5');
    expect(catalog).toMatchObject({ enabled: false, name: 'Claude Haiku 5.5' });
    expect(facts).toEqual({
      anthropicReasoning: {
        defaultEffort: 'medium',
        // Thinking can be disabled (at effort high or below), so it is not mandatory.
        mandatory: false,
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      contextWindow: 1_000_000,
      id: 'claude-haiku-5-5',
      label: 'Claude Haiku 5.5',
      maxOutputTokens: 128_000,
      nativeToolSearch: 'anthropic',
      pricing: {
        // The prompt-up-to-100K tier; longer prompts bill at five times these.
        cacheReadPerMTok: 0.01,
        cacheWritePerMTok: 0.125,
        inputPerMTok: 0.1,
        outputPerMTok: 0.5,
      },
      promptCaching: 'anthropic',
      supportsStreaming: true,
      tagline: 'For high-volume, latency-sensitive tasks',
      type: 'llm',
      vision: 'supported',
    });
  });

  it('promotes nothing: the Anthropic default stays Claude Sonnet 5', () => {
    expect(resolveDefaultModel('anthropic')).toBe('claude-sonnet-5');
  });
});
