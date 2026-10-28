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
 * https://platform.claude.com/docs/en/about-claude/pricing (BST-1691). Claude
 * Opus 5.5 is the second exception: 0.05x — $0.20 / MTok against $4 / MTok
 * input, same page, retrieved 2026-09-22 (BST-1804); the AWS Bedrock pricing
 * page's global rate for the Bedrock route is the same $0.20. Claude Sonnet
 * 5.5 is the third: 0.05x — $0.10 / MTok against $2 / MTok, same page,
 * retrieved 2026-10-28. Keyed on
 * the model identity WITHOUT the Bedrock `anthropic.` vendor prefix, so the
 * Bedrock route inherits the same documented exception rather than a second
 * hand-maintained list. Cache WRITES stay at the ordinary 1.25x on both models.
 */
const CACHE_READ_INPUT_MULTIPLIERS = new Map([
  ['claude-fable-5-1', 0.025],
  ['claude-opus-5-5', 0.05],
  ['claude-sonnet-5-5', 0.05],
]);
const DEFAULT_CACHE_READ_INPUT_MULTIPLIER = 0.1;

function cacheReadMultiplier(modelId: string): number {
  const identity = modelId.startsWith('anthropic.') ? modelId.slice('anthropic.'.length) : modelId;
  return CACHE_READ_INPUT_MULTIPLIERS.get(identity) ?? DEFAULT_CACHE_READ_INPUT_MULTIPLIER;
}

/** OpenAI's standard GPT-5.6 Sol tier, retrieved 2026-10-28 from both routes. */
const GPT_5_6_SOL_STANDARD = {
  cacheReadPerMTok: 0.4,
  cacheWritePerMTok: 5,
  inputPerMTok: 4,
  longContextTiers: [
    {
      cacheReadPerMTok: 0.8,
      cacheWritePerMTok: 10,
      inputPerMTok: 8,
      minPromptTokens: 272_000,
      outputPerMTok: 30,
    },
  ],
  outputPerMTok: 20,
};

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

  it('publishes cache-read pricing for explicit prompt-caching routes', () => {
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (
          model.type !== 'llm' ||
          model.pricing === undefined ||
          model.promptCaching === undefined
        ) {
          continue;
        }
        expect(model.pricing.cacheReadPerMTok, `${provider.id}/${model.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('prices Luna automatic caching without requesting an explicit cache dialect', () => {
    const luna = listProviderLlmModels('openai').find((model) => model.id === 'gpt-6-luna');
    expect(luna?.promptCaching).toBeUndefined();
    expect(luna?.pricing).toEqual({
      cacheReadPerMTok: 0.01,
      cacheWritePerMTok: 0.125,
      inputPerMTok: 0.1,
      longContextTiers: [
        {
          cacheReadPerMTok: 0.02,
          cacheWritePerMTok: 0.25,
          inputPerMTok: 0.2,
          minPromptTokens: 272_000,
          outputPerMTok: 0.75,
        },
      ],
      outputPerMTok: 0.5,
    });
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

  it('new hosted models carry current base-rate estimates', () => {
    const sol = listProviderLlmModels('openai').find((model) => model.id === 'gpt-5.6-sol');
    const fable = listProviderLlmModels('anthropic').find((model) => model.id === 'claude-fable-5');
    const sonnet = listProviderLlmModels('anthropic').find(
      (model) => model.id === 'claude-sonnet-5'
    );
    // BST-1698: OpenAI's 2026-08-21 cut, standard short-context tier; cache
    // and >272K rates re-read from the model page 2026-10-28.
    expect(sol?.pricing).toEqual(GPT_5_6_SOL_STANDARD);
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
    expect(sonnet?.pricing).toEqual({
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    // BST-1705 re-priced GLM-5.2 from 0.9282 / 2.9172 to 0.28 / 0.88 on
    // 2026-09-10; BST-1804 re-read the live base as 0.6496 / 2.0416 on 2026-09-23.
    expect(glm?.pricing).toEqual({
      cacheReadPerMTok: 0.120_64,
      inputPerMTok: 0.6496,
      outputPerMTok: 2.0416,
    });
    expect(spark?.pricing).toEqual({
      cacheReadPerMTok: 0.15,
      inputPerMTok: 1.25,
      outputPerMTok: 4.25,
    });
    expect(kimi?.pricing).toEqual({ cacheReadPerMTok: 0.3, inputPerMTok: 3, outputPerMTok: 15 });
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
    expect(rate('tencent/hy3')).toEqual({
      cacheReadPerMTok: 0.020_625,
      inputPerMTok: 0.0825,
      outputPerMTok: 0.33,
    });
    // `:batch` variant routes: 0.375 / 1.875 and 0.075 / 0.25 belong to
    // google/gemini-3.7-flash:batch and z-ai/glm-5.3-flash:batch, which are
    // separate routes we do not ship.
    expect(rate('google/gemini-3.7-flash')).toEqual({
      cacheReadPerMTok: 0.075,
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
    });
    expect(rate('z-ai/glm-5.3-flash')).toEqual({
      cacheReadPerMTok: 0.03,
      inputPerMTok: 0.15,
      outputPerMTok: 0.5,
    });
    // Exactly 2x the gateway's base rate, from an unidentified source: neither
    // the `:batch` twin (0.375 / 1.875) nor the direct `google` row, which
    // holds the same 0.75 / 3.75 this row now does.
    expect(rate('google/gemini-3.6-flash')).toEqual({
      cacheReadPerMTok: 0.075,
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
    });
  });

  /**
   * BST-1705 re-priced the `openrouter` GPT-5.x rows from the live Models API
   * and left the direct `openai` block alone (one ticket, one route's source).
   * BST-1804 then re-priced the direct block from developers.openai.com (pinned
   * below), so the two blocks agree again on these four models — but each is
   * still read from its OWN route's source. A sweep that copies one block over
   * the other re-introduces the stale-mirror failure both tickets fixed.
   */
  it('prices the OpenRouter GPT-5.x rows from the gateway, not from the stale direct block', () => {
    const models = listProviderLlmModels('openrouter');
    const rate = (id: string) => models.find((model) => model.id === id)?.pricing;
    // BST-1708: base rates unchanged; each row additionally carries its
    // gateway long-context tier.
    expect(rate('openai/gpt-5.5')).toEqual({
      cacheReadPerMTok: 0.5,
      inputPerMTok: 5,
      longContextTiers: [
        { cacheReadPerMTok: 1, inputPerMTok: 10, minPromptTokens: 272_000, outputPerMTok: 45 },
      ],
      outputPerMTok: 30,
    });
    expect(rate('openai/gpt-5.4')).toEqual({
      cacheReadPerMTok: 0.25,
      inputPerMTok: 2.5,
      longContextTiers: [
        { cacheReadPerMTok: 0.5, inputPerMTok: 5, minPromptTokens: 272_000, outputPerMTok: 22.5 },
      ],
      outputPerMTok: 15,
    });
    expect(rate('openai/gpt-5.6-terra')).toEqual({
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      inputPerMTok: 2,
      longContextTiers: [
        {
          cacheReadPerMTok: 0.4,
          cacheWritePerMTok: 5,
          inputPerMTok: 4,
          minPromptTokens: 272_000,
          outputPerMTok: 18,
        },
      ],
      outputPerMTok: 12,
    });
    expect(rate('openai/gpt-5.6-luna')).toEqual({
      cacheReadPerMTok: 0.02,
      cacheWritePerMTok: 0.25,
      inputPerMTok: 0.2,
      longContextTiers: [
        {
          cacheReadPerMTok: 0.04,
          cacheWritePerMTok: 0.5,
          inputPerMTok: 0.4,
          minPromptTokens: 272_000,
          outputPerMTok: 1.8,
        },
      ],
      outputPerMTok: 1.2,
    });
  });

  /**
   * BST-1698 priced the `openrouter` GPT-5.6 Sol row at 2/10 with a 4/15 tier
   * and pinned it as a genuine divergence from the direct 4/20 row. The
   * endpoints API (https://openrouter.ai/api/v1/models/openai/gpt-5.6-sol/endpoints,
   * retrieved 2026-10-28) shows that 2/10 belongs to the `openai/flex`
   * endpoint, a variant service tier; the standard `openai` endpoint bills
   * 4/20 with an 8/30 tier above 272K, the same as OpenAI's own page. Both
   * rows are still read from their own route's source; they now agree.
   */
  it('prices both GPT-5.6 Sol routes at the standard tier, not the flex endpoint', () => {
    const platformSol = listProviderLlmModels('openai').find((model) => model.id === 'gpt-5.6-sol');
    const routedSol = listProviderLlmModels('openrouter').find(
      (model) => model.id === 'openai/gpt-5.6-sol'
    );
    expect(platformSol?.pricing).toEqual(GPT_5_6_SOL_STANDARD);
    expect(routedSol?.pricing).toEqual(GPT_5_6_SOL_STANDARD);
  });

  /**
   * BST-1804. The direct `openai` rows had kept pre-2026 GPT-5 rates (five at
   * 1.25 / 10) and a 400K window on the four 1.05M models. Every value below is
   * OpenAI's standard short-context rate and context window as published on
   * https://developers.openai.com/api/docs/models/<id>, retrieved 2026-09-23.
   */
  it('prices the direct OpenAI rows from developers.openai.com', () => {
    const models = listProviderLlmModels('openai');
    const row = (id: string) => {
      const model = models.find((entry) => entry.id === id);
      return { contextWindow: model?.contextWindow, pricing: model?.pricing };
    };
    const priced = (inputPerMTok: number, outputPerMTok: number, contextWindow: number) => ({
      contextWindow,
      pricing: expect.objectContaining({ inputPerMTok, outputPerMTok }),
    });
    expect(row('gpt-5.6-terra')).toEqual(priced(2, 12, 1_050_000));
    expect(row('gpt-5.6-luna')).toEqual(priced(0.2, 1.2, 1_050_000));
    expect(row('gpt-5.5')).toEqual(priced(5, 30, 1_050_000));
    expect(row('gpt-5.5-pro')).toEqual(priced(30, 180, 1_050_000));
    expect(row('gpt-5.4')).toEqual(priced(2.5, 15, 1_050_000));
    expect(row('gpt-5.4-pro')).toEqual(priced(30, 180, 1_050_000));
    expect(row('gpt-5.4-mini')).toEqual(priced(0.75, 4.5, 400_000));
    expect(row('gpt-5.4-nano')).toEqual(priced(0.2, 1.25, 400_000));
    expect(row('gpt-5.3-codex')).toEqual(priced(1.75, 14, 400_000));
    expect(row('gpt-5.2')).toEqual(priced(1.75, 14, 400_000));
    expect(row('gpt-5.2-pro')).toEqual(priced(21, 168, 400_000));
  });

  // BST-1804: https://ai.google.dev/gemini-api/docs/pricing, Standard paid
  // tier (text/image/video input), retrieved 2026-09-23.
  it('prices Gemini 3.1 Flash-Lite from the Google pricing page', () => {
    const flashLite = listProviderLlmModels('google').find(
      (model) => model.id === 'gemini-3.1-flash-lite'
    );
    expect(flashLite?.pricing).toEqual({
      cacheReadPerMTok: 0.025,
      inputPerMTok: 0.25,
      outputPerMTok: 1.5,
    });
  });

  // BST-1804: same page, Standard paid tier; a flat rate with no prompt-size tier.
  it('prices the Gemini 3.8 Flash default from the Google pricing page', () => {
    const flash = listProviderLlmModels('google').find((model) => model.id === 'gemini-3.8-flash');
    // Introductory through 2026-12-31 (see the row note).
    expect(flash?.pricing).toEqual({
      cacheReadPerMTok: 0.075,
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
    });
  });

  // BST-1708: gateway long-context surcharge tiers (`min_prompt_tokens`
  // overrides), recorded per-MTok from the OpenRouter Models API. The
  // 2026-10-28 refresh added the vendors' own published tiers to the direct
  // OpenAI rows (2x input/cache and 1.5x output above 272K) and the direct
  // Gemini Pro rows (above 200K). Claude Haiku 5.5's tier is Anthropic's
  // published over-100K price, pinned in provider-registry-haiku-5-5.test.ts.
  it('carries long-context tiers on exactly the vendor-banded rows', () => {
    const tiered = new Map<string, unknown>();
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (model.type === 'llm' && model.pricing?.longContextTiers !== undefined) {
          tiered.set(`${provider.id}/${model.id}`, model.pricing.longContextTiers);
        }
      }
    }
    expect([...tiered.keys()].sort()).toEqual(
      [
        'anthropic/claude-haiku-5-5',
        'bedrock/anthropic.claude-haiku-5-5',
        'google/gemini-2.5-pro',
        'google/gemini-3.1-pro-preview',
        'openai/gpt-5.4',
        'openai/gpt-5.5',
        'openai/gpt-5.6-luna',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-terra',
        'openai/gpt-6-astra',
        'openai/gpt-6-luna',
        'openai/gpt-6-sol',
        'openai/gpt-6.1-sol',
        'openai/gpt-6.1-terra',
        'openrouter/anthropic/claude-haiku-5.5',
        'openrouter/google/gemini-3.1-pro-preview',
        'openrouter/openai/gpt-5.4',
        'openrouter/openai/gpt-5.5',
        'openrouter/openai/gpt-5.6-luna',
        'openrouter/openai/gpt-5.6-sol',
        'openrouter/openai/gpt-5.6-terra',
        'openrouter/openai/gpt-6-astra',
        'openrouter/openai/gpt-6-luna',
        'openrouter/openai/gpt-6-sol',
        'openrouter/openai/gpt-6.1-sol',
        'openrouter/openai/gpt-6.1-terra',
        'openrouter/qwen/qwen3.6-flash',
        'openrouter/qwen/qwen3.7-plus',
        'openrouter/x-ai/grok-4.5',
        'openrouter/x-ai/grok-4.6',
        'openrouter/x-ai/grok-4.7',
      ].sort()
    );
    expect(tiered.get('openrouter/openai/gpt-6-astra')).toEqual([
      {
        cacheReadPerMTok: 2,
        cacheWritePerMTok: 25,
        inputPerMTok: 20,
        minPromptTokens: 272_000,
        outputPerMTok: 75,
      },
    ]);
    expect(tiered.get('openrouter/x-ai/grok-4.7')).toEqual([
      {
        cacheReadPerMTok: 1,
        inputPerMTok: 4,
        minPromptTokens: 200_000,
        outputPerMTok: 12,
      },
    ]);
    expect(tiered.get('openrouter/qwen/qwen3.6-flash')).toEqual([
      {
        cacheWritePerMTok: 0.9375,
        inputPerMTok: 0.75,
        minPromptTokens: 256_000,
        outputPerMTok: 3,
      },
    ]);
  });
});
