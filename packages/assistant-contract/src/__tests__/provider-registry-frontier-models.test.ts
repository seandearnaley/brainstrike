import { describe, expect, it } from 'vitest';
import { resolveReasoningControlsAvailability } from '../model-reasoning.js';
import {
  type EmbeddingModelDefinition,
  getLlmModelDefinition,
  listProviderEmbeddingModels,
  listProviderLlmModels,
  listProviders,
  resolveDefaultModel,
} from '../provider-registry.js';

function llmIds(provider: Parameters<typeof listProviderLlmModels>[0]): string[] {
  return listProviderLlmModels(provider).map((model) => model.id);
}

describe('frontier model refresh (2026-07)', () => {
  describe('OpenAI', () => {
    it('exposes the generous GPT-5.x lineup and drops the chat-latest API model', () => {
      const ids = llmIds('openai');
      expect(ids).toEqual(
        expect.arrayContaining([
          'gpt-6-astra',
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5',
          'gpt-5.5-pro',
          'gpt-5.4',
          'gpt-5.4-pro',
          'gpt-5.4-mini',
          'gpt-5.4-nano',
          'gpt-5.3-codex',
          'gpt-5.2',
          'gpt-5.2-pro',
        ])
      );
      expect(ids).not.toContain('gpt-5.2-chat-latest');
    });

    it('defaults to the balanced gpt-5.6-terra', () => {
      expect(resolveDefaultModel('openai')).toBe('gpt-5.6-terra');
    });

    /**
     * BST-1692. Exhaustive so the row cannot gain a field by accident — in
     * particular `pricing.cacheReadPerMTok` / `cacheWritePerMTok`. OpenAI
     * publishes $1 cached input and $12.50 cache writes for this model, but a
     * cache RATE may only travel with a `promptCaching` dialect (BST-1354,
     * provider-registry-pricing.test.ts) and that enum has no `openai` member,
     * so the rates stay out of the catalog until a dialect exists.
     *
     * The `reasoning` block is the ladder OpenAI's model page documents. It is
     * declared rather than inherited because OPENAI_FAMILY_DEFAULT_EFFORTS
     * offers `minimal` (not on the page) and withholds `max` (on the page) —
     * see model-reasoning.test.ts for the availability-level pin.
     */
    it('declares GPT-6 Astra from the vendor model page, cache rates excluded (BST-1692)', () => {
      expect(getLlmModelDefinition('openai', 'gpt-6-astra')).toEqual({
        contextWindow: 1_050_000,
        id: 'gpt-6-astra',
        label: 'GPT-6 Astra',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: {
          inputPerMTok: 10,
          outputPerMTok: 50,
        },
        reasoning: {
          mandatory: false,
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        supportsStreaming: true,
        tokenMeasurement: {
          mode: 'declared-compatible-reference',
          tokenizer: 'o200k_base',
        },
        type: 'llm',
        vision: 'supported',
      });
    });

    /** BST-1692: OpenAI's own docs list no Astra Pro; OpenRouter is not the source. */
    it('does not carry a direct gpt-6-astra-pro row', () => {
      expect(llmIds('openai')).not.toContain('gpt-6-astra-pro');
    });
  });

  describe('Anthropic', () => {
    it('exposes Fable 5.1 / Fable 5 / Opus 5 / Sonnet 5 alongside the retained Opus and Haiku models', () => {
      const ids = llmIds('anthropic');
      expect(ids).toEqual([
        'claude-fable-5-1',
        'claude-fable-5',
        'claude-opus-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
      ]);
    });

    it('declares Claude Fable 5.1 from the vendor model-overview facts (BST-1691)', () => {
      const fable = getLlmModelDefinition('anthropic', 'claude-fable-5-1');

      expect(fable).toEqual({
        anthropicReasoning: {
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        contextWindow: 1_000_000,
        id: 'claude-fable-5-1',
        label: 'Claude Fable 5.1',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'anthropic',
        pricing: {
          // Cache reads are 0.025x base input on this model, not 0.1x.
          cacheReadPerMTok: 0.25,
          cacheWritePerMTok: 12.5,
          inputPerMTok: 10,
          outputPerMTok: 50,
        },
        promptCaching: 'anthropic',
        supportsStreaming: true,
        tagline: 'For demanding reasoning and long-horizon agentic work',
        type: 'llm',
        vision: 'supported',
      });
    });

    it('declares the Bedrock Claude Fable 5.1 route with the AWS model id (BST-1691)', () => {
      const fable = getLlmModelDefinition('bedrock', 'anthropic.claude-fable-5-1');

      expect(fable).toEqual({
        bedrockReasoning: 'adaptive',
        contextWindow: 1_000_000,
        id: 'anthropic.claude-fable-5-1',
        label: 'Claude Fable 5.1 (Bedrock)',
        maxOutputTokens: 128_000,
        pricing: {
          cacheReadPerMTok: 0.25,
          cacheWritePerMTok: 12.5,
          inputPerMTok: 10,
          outputPerMTok: 50,
        },
        promptCaching: 'bedrock',
        supportsStreaming: true,
        tagline: 'For demanding reasoning and long-horizon agentic work',
        type: 'llm',
        vision: 'supported',
      });
    });

    it('declares Claude Opus 5 from the vendor model-overview facts (BST-957)', () => {
      const opus = getLlmModelDefinition('anthropic', 'claude-opus-5');

      expect(opus).toEqual({
        anthropicReasoning: {
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        contextWindow: 1_000_000,
        id: 'claude-opus-5',
        label: 'Claude Opus 5',
        maxOutputTokens: 128_000,
        nativeToolSearch: 'anthropic',
        pricing: {
          cacheReadPerMTok: 0.5,
          cacheWritePerMTok: 6.25,
          inputPerMTok: 5,
          outputPerMTok: 25,
        },
        promptCaching: 'anthropic',
        supportsStreaming: true,
        tagline: 'For complex agentic coding and enterprise work',
        type: 'llm',
        vision: 'supported',
      });
    });

    it('drops the superseded 4-5 generation aliases', () => {
      const ids = llmIds('anthropic');
      expect(ids).not.toContain('claude-sonnet-4-5');
      expect(ids).not.toContain('claude-opus-4-5');
    });

    it('defaults to Sonnet 5', () => {
      expect(resolveDefaultModel('anthropic')).toBe('claude-sonnet-5');
    });
  });

  describe('Google', () => {
    it('exposes Gemini 3.5/3.1 + the 2.5 stable line', () => {
      const ids = llmIds('google');
      expect(ids).toEqual(
        expect.arrayContaining([
          'gemini-3.5-flash',
          'gemini-3.1-pro-preview',
          'gemini-3.1-flash-lite',
          'gemini-2.5-pro',
          'gemini-2.5-flash',
          'gemini-2.5-flash-lite',
        ])
      );
      expect(ids).not.toContain('gemini-3-flash-preview');
      expect(ids).not.toContain('gemini-3-pro-preview');
    });

    it('defaults to the stable gemini-3.5-flash', () => {
      expect(resolveDefaultModel('google')).toBe('gemini-3.5-flash');
    });

    it('adds gemini-embedding-2 while keeping 001 as the embedding default', () => {
      const embeddings = listProviderEmbeddingModels('google');
      const ids = embeddings.map((model) => model.id);
      expect(ids).toContain('gemini-embedding-2');
      expect(ids).toContain('gemini-embedding-001');
      expect(resolveDefaultModel('google', 'embedding')).toBe('gemini-embedding-001');

      const v2 = embeddings.find((model) => model.id === 'gemini-embedding-2') as
        | EmbeddingModelDefinition
        | undefined;
      expect(v2).toBeDefined();
      expect(v2?.defaultDimension).toBe(3072);
      expect(v2?.supportsCustomDimensions).toBe(true);
      expect(v2?.supportsStandardDimension).toBe(true);
      expect(v2?.dimensionParameter).toBe('output_dimensionality');
    });

    it('declares Gemini 3.7 Flash for the direct Google provider', () => {
      const gemini = getLlmModelDefinition('google', 'gemini-3.7-flash');

      expect(gemini).toEqual({
        contextWindow: 1_048_576,
        id: 'gemini-3.7-flash',
        label: 'Gemini 3.7 Flash',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.75, outputPerMTok: 3.75 },
        supportsStreaming: true,
        tagline: 'Fast multimodal reasoning for complex agentic workflows',
        type: 'llm',
        vision: 'supported',
      });
    });

    it('declares Gemini 3.8 Flash at the introductory 0.75/3.75 rate (BST-1693)', () => {
      expect(getLlmModelDefinition('google', 'gemini-3.8-flash')).toEqual({
        contextWindow: 1_048_576,
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.75, outputPerMTok: 3.75 },
        supportsStreaming: true,
        tagline: 'Long-horizon software engineering and autonomous agents at Flash speed',
        type: 'llm',
        vision: 'supported',
      });
    });

    it('declares Gemini 3.6 Flash at the introductory 0.75/3.75 rate (BST-1693)', () => {
      expect(getLlmModelDefinition('google', 'gemini-3.6-flash')).toEqual({
        contextWindow: 1_048_576,
        id: 'gemini-3.6-flash',
        label: 'Gemini 3.6 Flash',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.75, outputPerMTok: 3.75 },
        supportsStreaming: true,
        tagline: 'Frontier intelligence for code generation and agentic execution',
        type: 'llm',
        vision: 'supported',
      });
    });

    it('declares Gemini 3.5 Flash-Lite at its flat 0.30/2.50 rate (BST-1693)', () => {
      expect(getLlmModelDefinition('google', 'gemini-3.5-flash-lite')).toEqual({
        contextWindow: 1_048_576,
        id: 'gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash-Lite',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        supportsStreaming: true,
        tagline: 'Low-latency multimodal for high-throughput subagent tasks and document parsing',
        type: 'llm',
        vision: 'supported',
      });
    });

    it('keeps gemini-3.5-flash as the google default — 3.8 Flash is NOT promoted', () => {
      expect(resolveDefaultModel('google')).toBe('gemini-3.5-flash');
      expect(
        listProviderLlmModels('google').filter((model) => model.default === true)
      ).toHaveLength(1);
    });
  });

  describe('OpenRouter', () => {
    it('includes current frontier and top tool-capable Chinese models', () => {
      const ids = llmIds('openrouter');
      expect(ids).toEqual(
        expect.arrayContaining([
          'openai/gpt-5.6-sol',
          'openai/gpt-5.6-terra',
          'openai/gpt-5.6-luna',
          'anthropic/claude-fable-5',
          'anthropic/claude-sonnet-5',
          'z-ai/glm-5.2',
          'minimax/minimax-m3',
          'deepseek/deepseek-v4-pro',
          'deepseek/deepseek-v4-flash',
          'qwen/qwen3.7-max',
          'qwen/qwen3.7-plus',
          'qwen/qwen3.6-flash',
          'qwen/qwen3.8-27b',
          'qwen/qwen3.8-flash',
          'qwen/qwen3-coder-next',
          'meta/muse-spark-1.2',
          'meta/muse-spark-1.1',
          'moonshotai/kimi-k3',
          'poolside/laguna-s-2.1',
          'poolside/laguna-xs-2.1',
          'qwen/qwen3.8-2.4t-a95b',
          'nvidia/nemotron-3.5-lightning',
          'google/gemini-3.7-flash',
          'google/gemini-3.6-flash',
          'google/gemini-3.5-flash-lite',
          'meituan/longcat-2.0',
          'thinkingmachines/inkling',
          'kwaipilot/kat-coder-pro-v2.5',
          'x-ai/grok-4.6',
          'x-ai/grok-4.5',
          'moonshotai/kimi-k2.6',
          'moonshotai/kimi-k2.7-code',
          'openai/gpt-5.5',
          'openai/gpt-5.4',
          'openai/gpt-5.4-mini',
          'openai/gpt-5.3-codex',
          'openai/gpt-5.2',
          'anthropic/claude-opus-4.8',
          'anthropic/claude-sonnet-4.6',
          'anthropic/claude-haiku-4.5',
          'google/gemini-3.5-flash',
          'google/gemini-3.1-pro-preview',
          'google/gemini-2.5-flash',
        ])
      );
      expect(ids).not.toContain('anthropic/claude-sonnet-4.5');
      expect(ids).not.toContain('google/gemini-3-flash-preview');
      // BST-1697: delisted upstream, so they must not come back into the
      // catalog without a fresh route check.
      for (const delisted of [
        'stealth/ox-alpha',
        'qwen/qwen3.8-max',
        'inclusionai/ling-3.0-flash:free',
        'kwaipilot/kat-coder-air-v2.5',
      ]) {
        expect(ids).not.toContain(delisted);
      }
    });

    it('defaults to openai/gpt-5.6-terra', () => {
      expect(resolveDefaultModel('openrouter')).toBe('openai/gpt-5.6-terra');
    });

    it('declares GLM 5.3 from the frozen OpenRouter catalog facts', () => {
      const glm53 = getLlmModelDefinition('openrouter', 'z-ai/glm-5.3');

      expect(glm53).toEqual({
        contextWindow: 1_048_576,
        id: 'z-ai/glm-5.3',
        label: 'GLM-5.3 (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 1.4, outputPerMTok: 4.4 },
        reasoning: {
          defaultEffort: 'max',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['max', 'high', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      });
    });

    it("declares the new models' authoritative OpenRouter reasoning options", () => {
      const spark = getLlmModelDefinition('openrouter', 'meta/muse-spark-1.1');
      const kimi = getLlmModelDefinition('openrouter', 'moonshotai/kimi-k3');

      expect(spark.contextWindow).toBe(1_048_576);
      expect(spark.maxOutputTokens).toBeUndefined();
      expect(spark.reasoning).toEqual({
        defaultEffort: 'medium',
        mandatory: true,
        supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'minimal'],
      });
      expect(kimi.contextWindow).toBe(1_048_576);
      // Official Moonshot maximum completion window (BST-1170).
      expect(kimi.maxOutputTokens).toBe(1_048_576);
      expect(kimi.reasoning).toEqual({
        // Auto runs below the vendor default; recorded, not derived (BST-833).
        autoEffort: 'low',
        defaultEffort: 'max',
        defaultEnabled: true,
        mandatory: false,
        supportedEfforts: ['max', 'high', 'low'],
        // Official Moonshot completion window for always-on thinking
        // (BST-1170); OpenRouter publishes no max completion for this route.
        vendorDefaultOutputTokens: 131_072,
      });
    });

    it("declares Curator's July coding models with their audited limits", () => {
      const gemini = getLlmModelDefinition('openrouter', 'google/gemini-3.6-flash');
      const inkling = getLlmModelDefinition('openrouter', 'thinkingmachines/inkling');
      const grok = getLlmModelDefinition('openrouter', 'x-ai/grok-4.5');
      const longcat = getLlmModelDefinition('openrouter', 'meituan/longcat-2.0');

      expect(gemini).toMatchObject({
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        reasoning: {
          defaultEffort: 'medium',
          mandatory: true,
          supportedEfforts: ['high', 'medium', 'low', 'minimal'],
        },
        vision: 'supported',
      });
      expect(inkling).toMatchObject({
        contextWindow: 1_048_576,
        vision: 'supported',
      });
      // Provider figures: native 1M context, 128K max output. Guards against
      // reintroducing the 1_048_756 transposition or the unsourced 262_144.
      expect(longcat).toMatchObject({
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        vision: 'unsupported',
      });

      // These providers publish no reasoning-effort parameter, so the audit
      // left every one of these rows undeclared. `toMatchObject` above ignores
      // extra keys, so assert absence explicitly: without this, reintroducing a
      // fabricated effort ladder on any of them would pass untouched.
      for (const undeclared of [
        inkling,
        longcat,
        getLlmModelDefinition('openrouter', 'poolside/laguna-s-2.1'),
        getLlmModelDefinition('openrouter', 'poolside/laguna-xs-2.1'),
        getLlmModelDefinition('openrouter', 'kwaipilot/kat-coder-pro-v2.5'),
      ]) {
        expect(undeclared?.reasoning).toBeUndefined();
      }
      expect(grok).toMatchObject({
        contextWindow: 500_000,
        reasoning: {
          defaultEffort: 'high',
          mandatory: true,
          supportedEfforts: ['high', 'medium', 'low'],
        },
        vision: 'supported',
      });
    });

    it('declares Gemini 3.7 Flash from vendor capabilities and gateway metadata', () => {
      const gemini = getLlmModelDefinition('openrouter', 'google/gemini-3.7-flash');

      expect(gemini).toEqual({
        contextWindow: 1_048_576,
        id: 'google/gemini-3.7-flash',
        label: 'Gemini 3.7 Flash (OpenRouter)',
        maxOutputTokens: 65_536,
        pricing: { inputPerMTok: 0.375, outputPerMTok: 1.875 },
        reasoning: {
          defaultEffort: 'medium',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['high', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      });
    });

    it('declares Grok 4.6 from vendor capabilities and gateway metadata', () => {
      const grok = getLlmModelDefinition('openrouter', 'x-ai/grok-4.6');

      expect(grok).toEqual({
        contextWindow: 500_000,
        id: 'x-ai/grok-4.6',
        label: 'Grok 4.6 (OpenRouter)',
        pricing: { inputPerMTok: 2, outputPerMTok: 6 },
        reasoning: {
          defaultEffort: 'high',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['xhigh', 'high', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      });
      expect(grok.maxOutputTokens).toBeUndefined();
    });

    it('declares Muse Spark 1.2 from vendor capabilities and gateway metadata', () => {
      const spark = getLlmModelDefinition('openrouter', 'meta/muse-spark-1.2');

      expect(spark).toEqual({
        contextWindow: 1_048_576,
        id: 'meta/muse-spark-1.2',
        label: 'Muse Spark 1.2 (OpenRouter)',
        pricing: { inputPerMTok: 1.25, outputPerMTok: 4.25 },
        reasoning: {
          defaultEffort: 'medium',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'minimal'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      });
      expect(spark.maxOutputTokens).toBeUndefined();
    });

    it('declares Qwen3.8 27B from vendor capabilities and gateway metadata', () => {
      const qwen = getLlmModelDefinition('openrouter', 'qwen/qwen3.8-27b');

      expect(qwen).toEqual({
        contextWindow: 262_144,
        id: 'qwen/qwen3.8-27b',
        label: 'Qwen3.8 27B (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.45, outputPerMTok: 3.2 },
        reasoning: {
          defaultEffort: 'xhigh',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      });
    });

    it('declares Qwen3.8 Flash with its fixed route budgets and optional reasoning ladder', () => {
      const qwen = getLlmModelDefinition('openrouter', 'qwen/qwen3.8-flash');

      expect(qwen).toEqual({
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.8-flash',
        inputModalities: ['text', 'image', 'video'],
        label: 'Qwen3.8 Flash (OpenRouter)',
        maxOutputTokens: 131_072,
        outputModalities: ['text'],
        pricing: { inputPerMTok: 0.15, outputPerMTok: 0.47 },
        reasoning: {
          defaultEffort: 'xhigh',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'supported',
      });
      expect(resolveReasoningControlsAvailability('openrouter', 'qwen/qwen3.8-flash')).toEqual({
        available: true,
        defaultEffort: 'xhigh',
        efforts: ['xhigh', 'medium', 'low', 'none'],
        family: 'openrouter',
      });
    });

    it('declares Qwen3.8 2.4T A95B from vendor capabilities and gateway metadata', () => {
      const qwen = getLlmModelDefinition('openrouter', 'qwen/qwen3.8-2.4t-a95b');

      expect(qwen).toEqual({
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.8-2.4t-a95b',
        label: 'Qwen3.8 2.4T A95B (OpenRouter)',
        maxOutputTokens: 262_144,
        pricing: { inputPerMTok: 2, outputPerMTok: 6 },
        reasoning: {
          defaultEffort: 'xhigh',
          defaultEnabled: true,
          mandatory: true,
          supportedEfforts: ['xhigh', 'medium', 'low'],
        },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      });
    });

    it('declares Nemotron 3.5 Lightning from vendor capabilities and gateway metadata', () => {
      const nemotron = getLlmModelDefinition('openrouter', 'nvidia/nemotron-3.5-lightning');

      expect(nemotron).toEqual({
        contextWindow: 262_144,
        id: 'nvidia/nemotron-3.5-lightning',
        label: 'Nemotron 3.5 Lightning (OpenRouter)',
        maxOutputTokens: 131_072,
        pricing: { inputPerMTok: 0.08, outputPerMTok: 0.2 },
        reasoning: { mandatory: false, supportedEfforts: ['none'] },
        supportsStreaming: true,
        type: 'llm',
        vision: 'unsupported',
      });
    });
  });
});

describe('contextWindow metadata', () => {
  it('every LLM model declares a positive contextWindow', () => {
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (model.type === 'llm') {
          expect(model.contextWindow, `${provider.id}/${model.id}`).toBeGreaterThan(0);
          if (model.maxOutputTokens !== undefined) {
            // Equality is a real vendor contract: Kimi K3's official maximum
            // max_completion_tokens equals its 1M context window (BST-1170).
            // A configured reservation the context cannot fit is still
            // visibly blocked by the input-budget validation.
            expect(model.maxOutputTokens, `${provider.id}/${model.id}`).toBeLessThanOrEqual(
              model.contextWindow
            );
          }
        }
      }
    }
  });

  it('getLlmModelDefinition resolves a known model and throws on unknown ids', () => {
    expect(getLlmModelDefinition('anthropic', 'claude-sonnet-5').contextWindow).toBe(1_000_000);
    expect(getLlmModelDefinition('openrouter', 'z-ai/glm-5.2').maxOutputTokens).toBe(131_072);
    expect(() => getLlmModelDefinition('anthropic', 'no-such-model')).toThrow(/Unknown LLM model/);
    expect(() => getLlmModelDefinition('openai', 'claude-sonnet-4-6')).toThrow(/Unknown LLM model/);
  });
});
