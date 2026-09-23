import type { RuntimeData } from '@brainstrike/agent';
import { resolveOpenRouterCodingMaxOutputTokens } from '@brainstrike/assistant-contract';
import { deriveEffectiveInputBudget } from '@brainstrike/assistant-contract/context-budget';
import {
  findLlmModelDefinition,
  type ProviderId,
} from '@brainstrike/assistant-contract/provider-registry';
import { describe, expect, it } from 'vitest';
import { resolveCompactionInputBudget } from '../../assistant-server/conversation-compaction';

/**
 * BST-1707. Compaction must compact against the SAME budget the turn
 * enforces: `agentLoop.inputTokenLimit`, the number the renderer's
 * `buildAgentLoopSettings` resolves and threads through the request body
 * (also Mastra's TokenLimiter budget and the context meter's denominator).
 * Deriving a second budget from the catalog's hard `maxOutputTokens` diverged
 * from it wherever the request path reserves less output than the model's
 * maximum — every OpenRouter row above the 32,000-token coding cap.
 */

function catalogModel(provider: ProviderId, model: string) {
  const definition = findLlmModelDefinition(provider, model);
  if (!definition) {
    throw new Error(`Catalog row ${provider}/${model} is required by this test.`);
  }
  return definition;
}

/**
 * The run's real limit, reproduced from the SAME production pieces
 * `buildAgentLoopSettings` uses for OpenRouter (reservation capped at
 * OPENROUTER_CODING_MAX_OUTPUT_TOKENS), so this pins the rule rather than a
 * transcribed number that catalog drift would silently invalidate.
 */
function openRouterRunInputTokenLimit(model: string): number {
  const definition = catalogModel('openrouter', model);
  return deriveEffectiveInputBudget(
    definition.contextWindow,
    resolveOpenRouterCodingMaxOutputTokens(definition.maxOutputTokens)
  );
}

function runtime(model: string, inputTokenLimit?: number): RuntimeData {
  return {
    model,
    provider: 'openrouter',
    ...(inputTokenLimit === undefined ? {} : { agentLoop: { inputTokenLimit } }),
  } as RuntimeData;
}

describe('resolveCompactionInputBudget', () => {
  it('uses the run resolved limit, not the catalog derivation, for an OpenRouter model above the coding output cap', () => {
    const definition = catalogModel('openrouter', 'meta/muse-spark-1.3');
    expect(definition.maxOutputTokens ?? 0).toBeGreaterThan(32_000);

    const runLimit = openRouterRunInputTokenLimit('meta/muse-spark-1.3');
    const catalogDerivation = deriveEffectiveInputBudget(
      definition.contextWindow,
      definition.maxOutputTokens
    );

    // The two genuinely disagree — without that, this test could pass on a
    // still-broken implementation.
    expect(catalogDerivation).not.toBe(runLimit);
    expect(resolveCompactionInputBudget(runtime('meta/muse-spark-1.3', runLimit))).toBe(runLimit);
  });

  // BST-1804: this pinned moonshotai/kimi-k3 while its catalog row held
  // maxOutputTokens === contextWindow. Its row now holds the route's
  // top_provider pair (943,718 of 1,048,576), so minimax/minimax-m3
  // (512,000 of 524,288, leaving less than the safety margin) carries the case.
  it('no longer throws for minimax/minimax-m3, whose catalog derivation is impossible', () => {
    const definition = catalogModel('openrouter', 'minimax/minimax-m3');
    expect(() =>
      deriveEffectiveInputBudget(definition.contextWindow, definition.maxOutputTokens)
    ).toThrow();

    const runLimit = openRouterRunInputTokenLimit('minimax/minimax-m3');
    expect(resolveCompactionInputBudget(runtime('minimax/minimax-m3', runLimit))).toBe(runLimit);
  });

  it('keeps the catalog derivation for a run that carries no agentLoop', () => {
    const definition = catalogModel('openai', 'gpt-5.2');
    expect(
      resolveCompactionInputBudget({ model: 'gpt-5.2', provider: 'openai' } as RuntimeData)
    ).toBe(deriveEffectiveInputBudget(definition.contextWindow, definition.maxOutputTokens));
  });

  it('still throws for an unknown model with no agentLoop', () => {
    expect(() =>
      resolveCompactionInputBudget({
        model: 'not-a-catalog-model',
        provider: 'openrouter',
      } as RuntimeData)
    ).toThrow(/Unknown compaction input budget/);
  });

  it('throws — never silently substitutes the catalog value — when the run carries an unusable limit', () => {
    // The desktop assistant HTTP path does not sanitize `agentLoop`, so a
    // malformed limit must surface rather than resolve to a different,
    // plausible-looking budget.
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveCompactionInputBudget(runtime('meta/muse-spark-1.3', invalid))).toThrow(
        /invalid agentLoop\.inputTokenLimit/
      );
    }
  });
});
