import { describe, expect, it } from 'vitest';
import { listProviderLlmModels, listProviders } from '../provider-registry.js';

// BST-1697 delisted openrouter/stealth/ox-alpha, the only route that ever
// earned an explicit 0/0 rate. The allowlist stays as the guard: a new zero
// rate must be reviewed and added here rather than shipped silently.
const KNOWN_FREE_PRICED_MODEL_KEYS = new Set<string>([]);

/**
 * Anthropic prices cache reads at 0.1x base input on every Claude model EXCEPT
 * Claude Fable 5.1 (and the invite-only Claude Mythos 5.1), which read at
 * 0.025x — $0.25 / MTok against $10 / MTok input. Retrieved 2026-09-08 from
 * https://platform.claude.com/docs/en/about-claude/pricing (BST-1691). Keyed on
 * the model identity WITHOUT the Bedrock `anthropic.` vendor prefix, so the
 * Bedrock route inherits the same documented exception rather than a second
 * hand-maintained list. Cache WRITES stay at the ordinary 1.25x on this model.
 */
const CACHE_READ_INPUT_MULTIPLIERS = new Map([['claude-fable-5-1', 0.025]]);
const DEFAULT_CACHE_READ_INPUT_MULTIPLIER = 0.1;

function cacheReadMultiplier(modelId: string): number {
  const identity = modelId.startsWith('anthropic.') ? modelId.slice('anthropic.'.length) : modelId;
  return CACHE_READ_INPUT_MULTIPLIERS.get(identity) ?? DEFAULT_CACHE_READ_INPUT_MULTIPLIER;
}

describe('model pricing metadata', () => {
  it('keeps paid rates positive and limits zero rates to reviewed free routes', () => {
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (model.type !== 'llm' || model.pricing === undefined) {
          continue;
        }
        const { inputPerMTok, outputPerMTok } = model.pricing;
        expect(Number.isFinite(inputPerMTok), `${provider.id}/${model.id} inputPerMTok`).toBe(true);
        expect(Number.isFinite(outputPerMTok), `${provider.id}/${model.id} outputPerMTok`).toBe(
          true
        );
        const modelKey = `${provider.id}/${model.id}`;
        if (KNOWN_FREE_PRICED_MODEL_KEYS.has(modelKey)) {
          expect(inputPerMTok, `${modelKey} inputPerMTok`).toBe(0);
          expect(outputPerMTok, `${modelKey} outputPerMTok`).toBe(0);
          continue;
        }
        expect(inputPerMTok, `${modelKey} inputPerMTok`).toBeGreaterThan(0);
        expect(outputPerMTok, `${modelKey} outputPerMTok`).toBeGreaterThan(0);
      }
    }
  });

  it('every priced Anthropic model declares cache rates at the documented multipliers', () => {
    for (const model of listProviderLlmModels('anthropic')) {
      if (model.pricing === undefined) {
        continue;
      }
      const { cacheReadPerMTok, cacheWritePerMTok, inputPerMTok } = model.pricing;
      expect(cacheReadPerMTok, `anthropic/${model.id} cacheReadPerMTok`).toBeCloseTo(
        inputPerMTok * cacheReadMultiplier(model.id),
        10
      );
      expect(cacheWritePerMTok, `anthropic/${model.id} cacheWritePerMTok`).toBeCloseTo(
        inputPerMTok * 1.25,
        10
      );
    }
  });

  /**
   * BST-1354 replaced the old "Anthropic first-party only" pin. Bedrock
   * caching is real and separately billed, so the invariant is no longer about
   * a provider NAME — it is that a cache RATE and a cache DIALECT travel
   * together. A rate without `promptCaching` would price a discount the
   * runtime never requests; a dialect without a rate would under-report spend.
   */
  it('declares cache rates on exactly the routes that declare a prompt-caching dialect', () => {
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (model.type !== 'llm' || model.pricing === undefined) {
          continue;
        }
        const label = `${provider.id}/${model.id}`;
        if (model.promptCaching === undefined) {
          expect(model.pricing.cacheReadPerMTok, label).toBeUndefined();
          expect(model.pricing.cacheWritePerMTok, label).toBeUndefined();
          continue;
        }
        // A caching route always publishes a read rate; the WRITE premium is
        // optional because Nova bills writes at the ordinary input rate.
        expect(model.pricing.cacheReadPerMTok, label).toBeGreaterThan(0);
      }
    }
  });

  it('prices Anthropic-on-Bedrock cache tokens at the Anthropic multipliers', () => {
    const claudeRoutes = listProviderLlmModels('bedrock').filter(
      (model) => model.bedrockReasoning !== undefined && model.promptCaching === 'bedrock'
    );
    expect(claudeRoutes.length).toBeGreaterThan(0);
    for (const model of claudeRoutes) {
      const pricing = model.pricing;
      if (!pricing) {
        throw new Error(`bedrock/${model.id} must declare pricing`);
      }
      expect(pricing.cacheReadPerMTok, `bedrock/${model.id} cacheReadPerMTok`).toBeCloseTo(
        pricing.inputPerMTok * cacheReadMultiplier(model.id),
        10
      );
      expect(pricing.cacheWritePerMTok, `bedrock/${model.id} cacheWritePerMTok`).toBeCloseTo(
        pricing.inputPerMTok * 1.25,
        10
      );
    }
  });

  it('prices Amazon Nova cache reads at 0.25x input with no write premium', () => {
    const novaRoutes = listProviderLlmModels('bedrock').filter(
      (model) => model.id.startsWith('amazon.nova') && model.promptCaching === 'bedrock'
    );
    expect(novaRoutes.map((model) => model.id)).toEqual([
      'amazon.nova-pro-v1:0',
      'amazon.nova-lite-v1:0',
      'amazon.nova-micro-v1:0',
    ]);
    for (const model of novaRoutes) {
      const pricing = model.pricing;
      if (!pricing) {
        throw new Error(`bedrock/${model.id} must declare pricing`);
      }
      expect(pricing.cacheReadPerMTok, `bedrock/${model.id} cacheReadPerMTok`).toBeCloseTo(
        pricing.inputPerMTok * 0.25,
        10
      );
      // AWS bills Nova cache WRITES at the ordinary input rate — absence here
      // means "no premium", and must not drift into an invented rate.
      expect(pricing.cacheWritePerMTok, `bedrock/${model.id} cacheWritePerMTok`).toBeUndefined();
    }
  });

  it('the built-in local provider omits pricing (keyless models must not render $0)', () => {
    for (const model of listProviderLlmModels('local')) {
      expect(model.pricing, `local/${model.id}`).toBeUndefined();
    }
  });

  it('new hosted models carry current base-rate estimates', () => {
    const sol = listProviderLlmModels('openai').find((model) => model.id === 'gpt-5.6-sol');
    const fable = listProviderLlmModels('anthropic').find((model) => model.id === 'claude-fable-5');
    const sonnet = listProviderLlmModels('anthropic').find(
      (model) => model.id === 'claude-sonnet-5'
    );
    // BST-1698: OpenAI's 2026-08-21 cut, standard short-context tier.
    expect(sol?.pricing).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(fable?.pricing).toEqual({
      cacheReadPerMTok: 1,
      cacheWritePerMTok: 12.5,
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
    expect(sonnet?.pricing).toEqual({
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
  });

  it('tracks current OpenRouter base rates for Sonnet 5, GLM-5.2, Spark, and Kimi K3', () => {
    const models = listProviderLlmModels('openrouter');
    const sonnet = models.find((model) => model.id === 'anthropic/claude-sonnet-5');
    const glm = models.find((model) => model.id === 'z-ai/glm-5.2');
    const spark = models.find((model) => model.id === 'meta/muse-spark-1.1');
    const kimi = models.find((model) => model.id === 'moonshotai/kimi-k3');
    expect(sonnet?.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    // BST-1705: GLM-5.2 was re-priced from 0.9282 / 2.9172 on 2026-09-10.
    expect(glm?.pricing).toEqual({ inputPerMTok: 0.28, outputPerMTok: 0.88 });
    expect(spark?.pricing).toEqual({ inputPerMTok: 1.25, outputPerMTok: 4.25 });
    expect(kimi?.pricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  /**
   * BST-1705 corrected 21 of the 58 `openrouter` rows. THREE of them were not
   * merely stale — they were read from the WRONG NUMBER in an otherwise
   * correct payload, and each of those mistakes is repeatable by the next
   * author who reads the Models API without checking what they are looking at.
   * `scripts/openrouter-pricing-audit.mjs` can NAME all three (`surge-band`,
   * `variant-route:<id>`), and its own header carries the same three.
   *
   * FOUR rows are pinned here: those three, plus `google/gemini-3.6-flash`,
   * whose held 1.5 / 7.5 was exactly 2x the live base and matched no band, no
   * tier and no variant route — a wrong number the audit classifies only as
   * `moved-upstream`. Three named mistakes, four pinned rows; the counts are
   * not in conflict.
   *
   * The mechanised version of this rule is
   * `pnpm run audit:openrouter-pricing` (scripts/openrouter-pricing-audit.mjs);
   * it is not a required check because the fact lives upstream and moves
   * weekly. These pins are the part that CAN live in the required lane.
   */
  it('holds base rates, not surge bands or :batch routes, on the BST-1705 rows', () => {
    const models = listProviderLlmModels('openrouter');
    const rate = (id: string) => models.find((model) => model.id === id)?.pricing;
    // Time-of-day surge: 0.132 / 0.528 is this route's 00:00-16:00 UTC band.
    expect(rate('tencent/hy3')).toEqual({ inputPerMTok: 0.0825, outputPerMTok: 0.33 });
    // `:batch` variant routes: 0.375 / 1.875 and 0.075 / 0.25 belong to
    // google/gemini-3.7-flash:batch and z-ai/glm-5.3-flash:batch, which are
    // separate routes we do not ship.
    expect(rate('google/gemini-3.7-flash')).toEqual({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
    expect(rate('z-ai/glm-5.3-flash')).toEqual({ inputPerMTok: 0.15, outputPerMTok: 0.5 });
    // Exactly 2x the gateway's base rate, from an unidentified source: neither
    // the `:batch` twin (0.375 / 1.875) nor the direct `google` row, which
    // holds the same 0.75 / 3.75 this row now does.
    expect(rate('google/gemini-3.6-flash')).toEqual({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
  });

  /**
   * BST-1705 re-priced the `openrouter` GPT-5.x rows from the live Models API
   * and left the direct `openai` block alone (one ticket, one route's source).
   * The direct rows are therefore KNOWN STALE — five of them still carry the
   * old 1.25 / 10 GPT-5 rate — so these two blocks now disagree. That
   * disagreement is a to-do on the `openai` rows, NOT a defect in these ones:
   * a sweep that "reconciles" them by copying the direct block back over these
   * values would re-introduce the exact 4x understatement this ticket fixed.
   */
  it('prices the OpenRouter GPT-5.x rows from the gateway, not from the stale direct block', () => {
    const models = listProviderLlmModels('openrouter');
    const rate = (id: string) => models.find((model) => model.id === id)?.pricing;
    expect(rate('openai/gpt-5.5')).toEqual({ inputPerMTok: 5, outputPerMTok: 30 });
    expect(rate('openai/gpt-5.4')).toEqual({ inputPerMTok: 2.5, outputPerMTok: 15 });
    expect(rate('openai/gpt-5.6-terra')).toEqual({ inputPerMTok: 2, outputPerMTok: 12 });
    expect(rate('openai/gpt-5.6-luna')).toEqual({ inputPerMTok: 0.2, outputPerMTok: 1.2 });
  });

  /**
   * BST-1698. The two GPT-5.6 Sol routes are priced from DIFFERENT sources on
   * purpose: the `openai` row from OpenAI's standard short-context tier (4/20
   * after the 2026-08-21 cut) and the `openrouter` row from OpenRouter's own
   * published catalog (2/10, retrieved 2026-09-08). Every other GPT-5.6 row is
   * a faithful OpenRouter pass-through, so a future sweep could easily "fix"
   * this back into a mirror without reading the row note. This pin makes that
   * a failing test rather than a silent 2x cost misreport.
   */
  it('prices the two GPT-5.6 Sol routes from their own sources', () => {
    const platformSol = listProviderLlmModels('openai').find((model) => model.id === 'gpt-5.6-sol');
    const routedSol = listProviderLlmModels('openrouter').find(
      (model) => model.id === 'openai/gpt-5.6-sol'
    );
    expect(platformSol?.pricing).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(routedSol?.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(routedSol?.pricing).not.toEqual(platformSol?.pricing);
  });
});
