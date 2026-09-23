import type { RuntimeData } from '@brainstrike/agent';
import { describe, expect, it, vi } from 'vitest';

const buildModelSettingsOption = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  buildModelSettingsOption.mockImplementation(actual.buildModelSettingsOption);
  return { ...actual, buildModelSettingsOption };
});

const { resolveCompactionInputBudget } = await import(
  '../../assistant-server/conversation-compaction'
);

/**
 * The no-agentLoop fallback reads the request's output limit ONLY for
 * OpenRouter; a direct provider reserves the catalog maximum and never runs
 * the stream-option builder, so a rule that builder enforces can't fail a
 * direct-provider compaction.
 */
describe('resolveCompactionInputBudget request-output lookup', () => {
  it('does not build stream model settings for a direct-provider run', () => {
    buildModelSettingsOption.mockClear();
    resolveCompactionInputBudget({
      model: 'claude-opus-5-5',
      provider: 'anthropic',
    } as RuntimeData);
    expect(buildModelSettingsOption).not.toHaveBeenCalled();
  });

  it('builds them for an OpenRouter run', () => {
    buildModelSettingsOption.mockClear();
    resolveCompactionInputBudget({
      model: 'moonshotai/kimi-k3',
      provider: 'openrouter',
    } as RuntimeData);
    expect(buildModelSettingsOption).toHaveBeenCalledTimes(1);
  });
});
