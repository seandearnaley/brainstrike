import { describe, expect, it } from 'vitest';
import { MODEL_VENDOR_NAMES } from '../model-vendors.js';
import { PROVIDER_MODEL_DEFAULT_POLICIES } from '../provider-model-default-policies.js';
import {
  findModelVendor,
  getLlmModelDefinition,
  isArchivedModel,
  type LlmModelDefinition,
  listProviderLlmModels,
  listProviders,
  nextPricingChangeAfter,
  type ProviderDefinition,
  pricingChangeStartsAt,
  pricingInForceAt,
  resolveDefaultModel,
} from '../provider-registry.js';

/**
 * Catalog-wide invariants. Individual rows (prices, windows, lineups) live in
 * provider-catalog.json with their provenance in each row's `_note`; the
 * OpenRouter rows are re-checked against the live Models API by
 * `pnpm run audit:openrouter-pricing`. These tests hold the relationships a
 * row can break without the schema noticing.
 */

interface LlmRow {
  readonly key: string;
  readonly model: LlmModelDefinition;
}

function llmRows(): readonly LlmRow[] {
  return listProviders().flatMap((provider: ProviderDefinition) =>
    provider.models.flatMap((model) =>
      model.type === 'llm' ? [{ key: `${provider.id}/${model.id}`, model }] : []
    )
  );
}

/**
 * Anthropic prices cache reads at 0.1x base input except on the models below
 * (https://platform.claude.com/docs/en/about-claude/pricing; BST-1691 found
 * Fable 5.1 priced at the ordinary 0.1x). Cache writes are 1.25x everywhere.
 * Keyed without Bedrock's `anthropic.` prefix so both routes share one list.
 */
const ANTHROPIC_CACHE_READ_MULTIPLIERS = new Map([
  ['claude-fable-5-2', 0.025],
  ['claude-fable-5-1', 0.025],
  ['claude-opus-5-5', 0.05],
  ['claude-sonnet-5-5', 0.05],
]);

function anthropicCacheReadMultiplier(modelId: string): number {
  return ANTHROPIC_CACHE_READ_MULTIPLIERS.get(modelId.replace(/^anthropic\./u, '')) ?? 0.1;
}

describe('provider catalog identity', () => {
  it('gives every provider and every model within a provider a unique id', () => {
    const providerIds = listProviders().map((provider) => provider.id);
    expect(new Set(providerIds).size).toBe(providerIds.length);
    for (const provider of listProviders()) {
      const ids = provider.models.map((model) => model.id);
      expect(new Set(ids).size, `${provider.id} ids`).toBe(ids.length);
    }
  });

  it('resolves each default to exactly one real model', () => {
    for (const provider of listProviders()) {
      expect(
        provider.models.filter((model) => model.default === true).length,
        `${provider.id} defaults`
      ).toBeLessThanOrEqual(1);
      const defaultId = resolveDefaultModel(provider.id);
      expect(
        provider.models.some((model) => model.id === defaultId),
        `${provider.id} default`
      ).toBe(true);
    }
  });

  it('looks up a catalogued model and throws on an id from another provider', () => {
    const [first] = listProviderLlmModels('anthropic');
    expect(first).toBeDefined();
    expect(getLlmModelDefinition('anthropic', first?.id ?? '')).toBe(first);
    expect(() => getLlmModelDefinition('openai', first?.id ?? '')).toThrow(/Unknown LLM model/u);
  });
});

describe('model vendors', () => {
  it("names the provider itself as the maker of every model on a maker's own API", () => {
    for (const provider of listProviders()) {
      if (provider.id === 'openrouter' || provider.id === 'bedrock') {
        continue;
      }
      for (const model of provider.models) {
        // ChatGPT is OpenAI's own second route to its models.
        expect(model.vendor, `${provider.id}/${model.id}`).toBe(
          provider.id === 'chatgpt' ? 'openai' : provider.id
        );
      }
    }
  });

  it('serves on the ChatGPT route only models the OpenAI route also lists, unpriced', () => {
    const openai = new Map(listProviderLlmModels('openai').map((model) => [model.id, model]));
    for (const model of listProviderLlmModels('chatgpt')) {
      const metered = openai.get(model.id);
      expect(metered, model.id).toBeDefined();
      // A plan pays for these requests, and the route refuses OpenAI's native tool search.
      expect(model.pricing, model.id).toBeUndefined();
      expect(model.nativeToolSearch, model.id).toBeUndefined();
      expect(model.reasoning, model.id).toEqual(metered?.reasoning);
      expect(model.contextWindow, model.id).toBeLessThanOrEqual(metered?.contextWindow ?? 0);
    }
  });

  it('declares one maker for a model however many routes serve it', () => {
    // Claude on Anthropic's API, OpenRouter and Bedrock is one maker's model.
    expect(findModelVendor('anthropic', 'claude-opus-5-5')).toBe('anthropic');
    expect(findModelVendor('openrouter', 'anthropic/claude-opus-5.5')).toBe('anthropic');
    expect(findModelVendor('bedrock', 'anthropic.claude-opus-5-5')).toBe('anthropic');
    expect(findModelVendor('bedrock', 'amazon.nova-pro-v1:0')).toBe('amazon');
    expect(findModelVendor('openrouter', 'not/a-catalogued-model')).toBeUndefined();
  });

  it('lists only makers some catalog row declares', () => {
    const declared = new Set(llmRows().map(({ model }) => model.vendor));
    expect([...declared].sort()).toEqual(Object.keys(MODEL_VENDOR_NAMES).sort());
  });
});

describe('model limits', () => {
  it('declares a positive context window that fits every output limit', () => {
    for (const { key, model } of llmRows()) {
      expect(model.contextWindow, key).toBeGreaterThan(0);
      // Equality is a real vendor contract: Kimi K3's maximum completion
      // equals its context window (BST-1170).
      if (model.maxOutputTokens !== undefined) {
        expect(model.maxOutputTokens, key).toBeGreaterThan(0);
        expect(model.maxOutputTokens, key).toBeLessThanOrEqual(model.contextWindow);
      }
    }
  });
});

describe('model lifecycle', () => {
  it('points an archived model at a current model on its own provider', () => {
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        const replacedBy = model.lifecycle?.replacedBy;
        if (replacedBy === undefined) {
          continue;
        }
        const successor = provider.models.find((candidate) => candidate.id === replacedBy);
        expect(successor, `${provider.id}/${model.id} replacedBy`).toBeDefined();
        expect(successor && isArchivedModel(successor), `${provider.id}/${replacedBy}`).toBe(false);
      }
    }
  });

  it("dates a deprecation with the vendor's retirement day, in order", () => {
    for (const { key, model } of llmRows()) {
      const lifecycle = model.lifecycle;
      if (lifecycle === undefined) {
        continue;
      }
      if (lifecycle.status === 'deprecated') {
        expect(lifecycle.retiresAt, key).toBeDefined();
      }
      const days = [lifecycle.releasedAt, lifecycle.deprecatedAt, lifecycle.retiresAt].filter(
        (day) => day !== undefined
      );
      expect(days, key).toEqual([...days].sort());
    }
  });

  it('never recommends or seeds an archived model', () => {
    for (const provider of listProviders()) {
      const policy = PROVIDER_MODEL_DEFAULT_POLICIES[provider.id];
      const seeded = new Set<string>(policy.kind === 'seed' ? policy.modelIds : []);
      for (const model of provider.models.filter(isArchivedModel)) {
        const key = `${provider.id}/${model.id}`;
        expect(model.default === true, `${key} is a recommended default`).toBe(false);
        expect(seeded.has(model.id), `${key} is in the seed list`).toBe(false);
      }
      const fallback = resolveDefaultModel(provider.id);
      const resolved = provider.models.find((model) => model.id === fallback);
      expect(resolved && isArchivedModel(resolved), `${provider.id} default`).toBe(false);
    }
  });
});

describe('model pricing', () => {
  it('keeps every rate positive, with cache reads below input', () => {
    for (const { key, model } of llmRows()) {
      const pricing = model.pricing;
      if (pricing === undefined) {
        continue;
      }
      const rateSets = [pricing, ...(pricing.changes ?? [])];
      for (const band of rateSets.flatMap((rates) => [rates, ...(rates.longContextTiers ?? [])])) {
        expect(band.inputPerMTok, `${key} input`).toBeGreaterThan(0);
        expect(band.outputPerMTok, `${key} output`).toBeGreaterThan(0);
        if (band.cacheReadPerMTok !== undefined) {
          expect(band.cacheReadPerMTok, `${key} cache read`).toBeGreaterThan(0);
          expect(band.cacheReadPerMTok, `${key} cache read`).toBeLessThan(band.inputPerMTok);
        }
        // Writes have no general bound: Gemini on OpenRouter bills them below input.
        if (band.cacheWritePerMTok !== undefined) {
          expect(band.cacheWritePerMTok, `${key} cache write`).toBeGreaterThan(0);
        }
      }
      if (model.promptCaching !== undefined) {
        expect(pricing.cacheReadPerMTok, `${key} cache read`).toBeDefined();
      }
    }
  });

  it('lists dated price changes oldest first, one per day', () => {
    for (const { key, model } of llmRows()) {
      const starts = (model.pricing?.changes ?? []).map(pricingChangeStartsAt);
      for (const [index, startsAt] of starts.entries()) {
        expect(startsAt, `${key} change ${index}`).toBeGreaterThan(
          starts[index - 1] ?? Number.NEGATIVE_INFINITY
        );
      }
    }
  });

  it('orders long-context tiers by prompt size, inside the window, never cheaper than the base', () => {
    for (const { key, model } of llmRows()) {
      const tiers = model.pricing?.longContextTiers;
      if (model.pricing === undefined || tiers === undefined) {
        continue;
      }
      let previous = { ...model.pricing, minPromptTokens: 0 };
      for (const tier of tiers) {
        expect(tier.minPromptTokens, key).toBeGreaterThan(previous.minPromptTokens);
        expect(tier.minPromptTokens, key).toBeLessThan(model.contextWindow);
        expect(tier.inputPerMTok, key).toBeGreaterThanOrEqual(previous.inputPerMTok);
        expect(tier.outputPerMTok, key).toBeGreaterThanOrEqual(previous.outputPerMTok);
        previous = { ...previous, ...tier };
      }
    }
  });

  it('prices Claude cache tokens at the Anthropic multipliers on both routes', () => {
    const claudeRoutes = [
      ...listProviderLlmModels('anthropic'),
      ...listProviderLlmModels('bedrock').filter((model) => model.id.startsWith('anthropic.')),
    ].filter((model) => model.pricing !== undefined);
    expect(claudeRoutes.length).toBeGreaterThan(0);
    for (const model of claudeRoutes) {
      const { cacheReadPerMTok, cacheWritePerMTok, inputPerMTok } = model.pricing ?? {
        inputPerMTok: Number.NaN,
      };
      expect(cacheReadPerMTok, `${model.id} cache read`).toBeCloseTo(
        inputPerMTok * anthropicCacheReadMultiplier(model.id),
        10
      );
      expect(cacheWritePerMTok, `${model.id} cache write`).toBeCloseTo(inputPerMTok * 1.25, 10);
    }
  });

  it('prices Amazon Nova cache reads at 0.25x input with no invented write premium', () => {
    const nova = listProviderLlmModels('bedrock').filter(
      (model) => model.id.startsWith('amazon.nova') && model.promptCaching === 'bedrock'
    );
    expect(nova.length).toBeGreaterThan(0);
    for (const model of nova) {
      expect(model.pricing?.cacheReadPerMTok, model.id).toBeCloseTo(
        (model.pricing?.inputPerMTok ?? Number.NaN) * 0.25,
        10
      );
      // AWS bills Nova cache writes at the ordinary input rate.
      expect(model.pricing?.cacheWritePerMTok, model.id).toBeUndefined();
    }
  });

  /**
   * BST-1705 and BST-1698 found OpenRouter rows priced from the wrong number in
   * a correct payload: a time-of-day surge band, a `:batch` twin route, and the
   * `openai/flex` service tier. The audit script names those classes; these
   * pins keep the corrected rows from sliding back.
   */
  it.each([
    ['tencent/hy3', 0.0825, 0.33],
    ['google/gemini-3.7-flash', 0.75, 3.75],
    ['z-ai/glm-5.3-flash', 0.15, 0.5],
    ['openai/gpt-5.6-sol', 4, 20],
  ] as const)('holds the OpenRouter base rate for %s, not a variant route', (id, input, output) => {
    expect(getLlmModelDefinition('openrouter', id).pricing).toMatchObject({
      inputPerMTok: input,
      outputPerMTok: output,
    });
  });
});

describe('reasoning ladders', () => {
  const ANTHROPIC_RANK = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('orders every Anthropic ladder weakest to strongest and offers its default', () => {
    for (const { key, model } of llmRows()) {
      const ladder = model.anthropicReasoning;
      if (ladder === undefined) {
        continue;
      }
      expect(ladder.supportedEfforts, key).toContain(ladder.defaultEffort);
      const ranks = ladder.supportedEfforts.map((effort) => ANTHROPIC_RANK.indexOf(effort));
      expect(ranks, key).toEqual([...ranks].sort((a, b) => a - b));
      expect(new Set(ranks).size, key).toBe(ranks.length);
    }
  });

  it('offers every declared default effort in the model ladder', () => {
    for (const { key, model } of llmRows()) {
      const reasoning = model.reasoning;
      if (reasoning === undefined) {
        continue;
      }
      const offered: readonly string[] = reasoning.supportedEfforts;
      expect(new Set(offered).size, key).toBe(offered.length);
      if (reasoning.defaultEffort !== undefined) {
        expect(offered, key).toContain(reasoning.defaultEffort);
      }
    }
  });
});

describe('pricingInForceAt', () => {
  const pricing = {
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 0.2,
    changes: [
      { cacheReadPerMTok: 0.2, effectiveFrom: '2026-12-01', inputPerMTok: 4, outputPerMTok: 20 },
      { effectiveFrom: '2027-03-01', inputPerMTok: 3, outputPerMTok: 15 },
    ],
    inputPerMTok: 2,
    outputPerMTok: 10,
  };

  it('bills the rates before every change until the first one starts at 00:00 UTC', () => {
    expect(pricingInForceAt(pricing, Date.UTC(2026, 11, 1) - 1)).toEqual({
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 0.2,
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
  });

  it('bills a change as a whole rate set: a rate it leaves out is unknown, not carried over', () => {
    expect(pricingInForceAt(pricing, Date.UTC(2026, 11, 1))).toEqual({
      cacheReadPerMTok: 0.2,
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
    expect(pricingInForceAt(pricing, Date.UTC(2027, 5, 1))).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });

  it('names the next change still to come', () => {
    expect(nextPricingChangeAfter(pricing, Date.UTC(2026, 10, 20))?.effectiveFrom).toBe(
      '2026-12-01'
    );
    expect(nextPricingChangeAfter(pricing, Date.UTC(2026, 11, 1))?.effectiveFrom).toBe(
      '2027-03-01'
    );
    expect(nextPricingChangeAfter(pricing, Date.UTC(2027, 2, 1))).toBeUndefined();
  });
});
