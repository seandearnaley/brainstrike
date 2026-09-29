import { describe, expect, it } from 'vitest';
import type { LlmModelDefinition, ProviderModelDefinition } from '../provider-registry.js';
import { getProviderDefinition, listProviders } from '../provider-registry.js';

function llmModels(models: readonly ProviderModelDefinition[]): LlmModelDefinition[] {
  return models.filter((model): model is LlmModelDefinition => model.type === 'llm');
}

/**
 * OpenAI Codex (ChatGPT subscription) registry entry — BST-1356.
 *
 * The model set mirrors opencode's `ALLOWED_MODELS` (re-verified against
 * `anomalyco/opencode` `dev` HEAD 0033bb3559 on 2026-08-18 per legal gate
 * constraint 8). Membership is asserted EXACTLY, in both directions, because
 * silently gaining a model here would offer users a route their subscription
 * may not cover, and silently losing one would strand a working model.
 */

/**
 * `codex/`-prefixed because the `models` table's `id` is a GLOBAL primary key:
 * a bare `gpt-5.5` row would collide with — and on upsert HIJACK — the
 * platform `openai` row of the same id. Same reason openrouter uses `openai/…`.
 */
const ALLOWED_MODEL_IDS = [
  'codex/gpt-5.3-codex-spark',
  'codex/gpt-5.4',
  'codex/gpt-5.4-mini',
  'codex/gpt-5.5',
];

/** Excluded upstream: reasoningMode "pro" routes and gpt-5.6. */
const EXCLUDED_MODEL_IDS = [
  'codex/gpt-5.4-pro',
  'codex/gpt-5.5-pro',
  'codex/gpt-5.6',
  'codex/gpt-5.6-terra',
];

describe('openai-codex provider definition', () => {
  const provider = getProviderDefinition('openai-codex');

  it('is a hosted, oauth-subscription provider with no environment keys', () => {
    expect(provider.runtime).toBe('hosted');
    expect(provider.authType).toBe('oauth_subscription');
    // Subscription auth is interactive-only (gate constraint 4): there is no
    // environment variable that can authenticate this provider.
    expect(provider.envKeys).toEqual([]);
  });

  it('is the first carrier of the oauth_subscription auth type', () => {
    const oauthProviders = listProviders()
      .filter((entry) => entry.authType === 'oauth_subscription')
      .map((entry) => entry.id);
    expect(oauthProviders).toEqual(['openai-codex']);
  });

  it('names itself for the subscription, not the platform API', () => {
    expect(provider.displayName).toBe('OpenAI (ChatGPT)');
  });

  it('exposes exactly the upstream-allowed model set', () => {
    expect(provider.models.map((model) => model.id).sort()).toEqual(ALLOWED_MODEL_IDS);
  });

  it('excludes the pro routes and gpt-5.6', () => {
    const ids = new Set(provider.models.map((model) => model.id));
    for (const excluded of EXCLUDED_MODEL_IDS) {
      expect(ids.has(excluded), `${excluded} must not be offered on subscription auth`).toBe(false);
    }
  });

  it('omits pricing on every model so the UI renders "cost unavailable"', () => {
    // Usage draws on the user's subscription, not metered per-token billing.
    // A zero price would be a LIE about cost, not an absence of one.
    for (const model of provider.models) {
      expect(model, `${model.id} must not declare pricing`).not.toHaveProperty('pricing');
      expect(model).not.toHaveProperty('promptCaching');
    }
  });

  it('offers only llm models (no embedding rows)', () => {
    expect(llmModels(provider.models)).toHaveLength(provider.models.length);
  });

  it('tells the user the models are subscription-included', () => {
    for (const model of llmModels(provider.models)) {
      expect(model.tagline, `${model.id} tagline`).toMatch(/subscription/i);
    }
  });

  it('commits vision per the same families as the base OpenAI entries', () => {
    const openai = llmModels(getProviderDefinition('openai').models);
    for (const model of llmModels(provider.models)) {
      // gpt-5.3-codex-spark has no direct base row; its family anchor is
      // gpt-5.3-codex, which the base registry declares vision-supported.
      const bare = model.id.replace(/^codex\//, '');
      const anchorId = bare === 'gpt-5.3-codex-spark' ? 'gpt-5.3-codex' : bare;
      const anchor = openai.find((entry) => entry.id === anchorId);
      expect(anchor, `${model.id} needs a base OpenAI family anchor`).toBeDefined();
      expect(model.vision, `${model.id} vision`).toBe(anchor?.vision);
      expect(model.vision).toBe('supported');
    }
  });

  it('applies the upstream context/output limits', () => {
    for (const model of llmModels(provider.models)) {
      // opencode pins gpt-5.5 to 400k context / 128k output. Each codex row
      // declares its own limits; they are not inherited from the base `openai`
      // rows (which carry OpenAI's 1.05M window for gpt-5.5 and gpt-5.4).
      expect(model.contextWindow, `${model.id} context`).toBe(400_000);
      expect(model.maxOutputTokens, `${model.id} max output`).toBe(128_000);
    }
  });

  it('streams and has a single default model', () => {
    const defaults = provider.models.filter((model) => model.default === true);
    expect(defaults.map((model) => model.id)).toEqual(['codex/gpt-5.5']);
    for (const model of llmModels(provider.models)) {
      expect(model.supportsStreaming, `${model.id} streaming`).toBe(true);
      expect(model.type).toBe('llm');
    }
  });

  it('declares llm capabilities without embeddings', () => {
    expect(provider.capabilities.llm).toBe(true);
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.embeddings).toBe(false);
  });

  it('points at OpenAI’s own Codex auth documentation', () => {
    expect(provider.docsUrl).toBe('https://developers.openai.com/codex/auth');
  });
});
