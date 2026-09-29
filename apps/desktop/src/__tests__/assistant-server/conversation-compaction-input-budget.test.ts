import type { RuntimeData } from '@brainstrike/agent';
import {
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
} from '@brainstrike/assistant-contract';
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

  it('keeps the catalog derivation for a direct-provider run that carries no agentLoop', () => {
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

/**
 * BST-1804. A run with NO `agentLoop` must compact against the number the
 * renderer's canonical derivation would have sent for the same model at
 * default settings — never a second formula. At default settings the renderer
 * sizes an OpenRouter reservation through `buildEffectiveModelSettings`
 * (the Auto reasoning resolution's output window, BST-1170) and feeds it to
 * `buildAgentLoopSettings`; a direct provider reserves the catalog maximum.
 * `defaultSettingsInputTokenLimit` reproduces that from the same production
 * pieces, and packages/app-shell pins the renderer to this same reproduction
 * for these rows, so the two sides cannot drift apart silently.
 *
 * The OLD fallback reserved the OpenRouter row's HARD maximum. Once this
 * branch corrected those rows to their top-provider figures, that gave 25-52K
 * budgets on 0.5-1M windows, and threw outright for minimax/minimax-m3.
 */
function defaultSettingsInputTokenLimit(provider: ProviderId, model: string): number {
  const definition = catalogModel(provider, model);
  const outputReservation =
    provider === 'openrouter'
      ? resolveOpenRouterOutputWindow(definition, resolveOpenRouterReasoningActive(definition))
      : definition.maxOutputTokens;
  return deriveEffectiveInputBudget(definition.contextWindow, outputReservation);
}

function hardMaximumInputBudget(provider: ProviderId, model: string): number | 'throws' {
  const definition = catalogModel(provider, model);
  try {
    return deriveEffectiveInputBudget(definition.contextWindow, definition.maxOutputTokens);
  } catch {
    return 'throws';
  }
}

describe('resolveCompactionInputBudget without an agentLoop (BST-1804)', () => {
  it.each(['moonshotai/kimi-k3', 'minimax/minimax-m3', 'x-ai/grok-4.7'])(
    'uses the canonical default-settings derivation for openrouter/%s',
    (model) => {
      const expected = defaultSettingsInputTokenLimit('openrouter', model);
      // Non-vacuous: the old hard-maximum formula genuinely disagrees.
      expect(hardMaximumInputBudget('openrouter', model)).not.toBe(expected);
      expect(resolveCompactionInputBudget(runtime(model))).toBe(expected);
    }
  );

  it('no longer throws for minimax/minimax-m3, whose hard-maximum derivation is impossible', () => {
    expect(hardMaximumInputBudget('openrouter', 'minimax/minimax-m3')).toBe('throws');
    expect(() => resolveCompactionInputBudget(runtime('minimax/minimax-m3'))).not.toThrow();
  });

  it('matches the canonical derivation for a direct-provider row (anthropic/claude-opus-5-5)', () => {
    expect(
      resolveCompactionInputBudget({
        model: 'claude-opus-5-5',
        provider: 'anthropic',
      } as RuntimeData)
    ).toBe(defaultSettingsInputTokenLimit('anthropic', 'claude-opus-5-5'));
  });

  it('reserves the output an OpenRouter run explicitly sends', () => {
    const definition = catalogModel('openrouter', 'moonshotai/kimi-k3');
    expect(
      resolveCompactionInputBudget({
        ...runtime('moonshotai/kimi-k3'),
        modelSettings: { maxOutputTokens: 64_000 },
      })
    ).toBe(deriveEffectiveInputBudget(definition.contextWindow, 64_000));
  });

  it('throws — never a plausible budget — when an OpenRouter run sends a malformed output limit', () => {
    // The desktop HTTP path does not sanitize `modelSettings`, and
    // `buildModelSettingsOption` lets an explicit value override the backstop,
    // so the shared derivation must reject it rather than budget around it.
    for (const invalid of [0, -1, 1.5, Number.NaN, null]) {
      expect(() =>
        resolveCompactionInputBudget({
          ...runtime('moonshotai/kimi-k3'),
          modelSettings: { maxOutputTokens: invalid as number },
        })
      ).toThrow(/output limit the request sends/);
    }
  });

  it('sizes the OpenRouter reservation for the reasoning state the run carries', () => {
    // kimi-k3 records a vendor completion window used only while reasoning is
    // active; a run that switches reasoning off reserves the coding ceiling.
    const definition = catalogModel('openrouter', 'moonshotai/kimi-k3');
    const reasoningOff = deriveEffectiveInputBudget(
      definition.contextWindow,
      resolveOpenRouterCodingMaxOutputTokens(definition.maxOutputTokens)
    );
    expect(reasoningOff).not.toBe(
      defaultSettingsInputTokenLimit('openrouter', 'moonshotai/kimi-k3')
    );
    expect(
      resolveCompactionInputBudget({
        ...runtime('moonshotai/kimi-k3'),
        providerOptions: { openrouter: { reasoning: { enabled: false } } },
      } as RuntimeData)
    ).toBe(reasoningOff);
  });
});
