import {
  getProviderDefaultModel,
  resolveScaledToolResultBudget,
  resolveToolResultBudgetForModel,
  TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW,
} from '@brainstrike/agent';
import type { ScopedLogger } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import { resolveToolBuildBudget } from '../stream-init';

const logger = {
  warn: vi.fn(),
} as unknown as ScopedLogger;

describe('resolveToolBuildBudget', () => {
  it('matches the runtime resolver for the same normalized provider and model', () => {
    const model = 'gpt-5.4-mini';

    expect(resolveToolBuildBudget({ model, provider: ' OpenAI ' }, logger)).toEqual(
      resolveToolResultBudgetForModel('openai', model)
    );
  });

  it('uses the same provider default model fallback as the runtime', () => {
    const model = getProviderDefaultModel('openai');
    expect(model).toBeDefined();

    expect(resolveToolBuildBudget({ provider: ' OPENAI ' }, logger)).toEqual(
      resolveToolResultBudgetForModel('openai', model ?? '')
    );
  });

  it.each([
    undefined,
    '',
    'not-a-provider',
  ])('falls back visibly to the anchor for invalid provider %j', (provider) => {
    logger.warn = vi.fn();

    expect(resolveToolBuildBudget(provider === undefined ? {} : { provider }, logger)).toEqual(
      resolveScaledToolResultBudget(TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW)
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Cannot resolve tool-result budget for tool construction; using anchor fallback.',
      expect.objectContaining({
        code: 'tool_result_budget_invalid_provider_fallback',
      })
    );
  });
});
