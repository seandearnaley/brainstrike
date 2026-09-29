import { describe, expect, it } from 'vitest';
import { OPENROUTER_RECOMMENDED_CODING_MODEL_IDS } from '../openrouter-coding-defaults.js';
import {
  getLlmModelDefinition,
  type LlmModelDefinition,
  resolveDefaultModel,
} from '../provider-registry.js';

/**
 * BST-1804 catalog refresh, sources retrieved 2026-09-22. Every row is pinned
 * exhaustively so it cannot gain a field by accident; the provenance for each
 * value lives in the row's `_note` in provider-catalog.json.
 */
describe('2026-09 catalog refresh (BST-1804)', () => {
  /**
   * OpenAI model pages. Cache rates are published but omitted: a cache rate
   * may only travel with a `promptCaching` dialect and there is no `openai`
   * member (BST-1354). The ladder is declared because the undeclared family
   * default offers `minimal` (not on the page) and withholds `max` (on it).
   */
  it.each([
    ['gpt-6-sol', 'GPT-6 Sol', 2, 10],
    ['gpt-6-luna', 'GPT-6 Luna', 0.1, 0.5],
  ] as const)(
    'declares %s from its OpenAI model page',
    (id, label, inputPerMTok, outputPerMTok) => {
      expect(getLlmModelDefinition('openai', id)).toEqual({
        contextWindow: 1_050_000,
        id,
        label,
        maxOutputTokens: 128_000,
        nativeToolSearch: 'openai',
        pricing: { inputPerMTok, outputPerMTok },
        reasoning: {
          defaultEffort: 'medium',
          mandatory: false,
          supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
        supportsStreaming: true,
        tokenMeasurement: { mode: 'declared-compatible-reference', tokenizer: 'o200k_base' },
        type: 'llm',
        vision: 'supported',
      });
    }
  );

  it('declares Claude Opus 5.5 from the vendor model page: always-on thinking, medium default', () => {
    expect(getLlmModelDefinition('anthropic', 'claude-opus-5-5')).toEqual({
      anthropicReasoning: {
        defaultEffort: 'medium',
        mandatory: true,
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      contextWindow: 1_000_000,
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      maxOutputTokens: 128_000,
      nativeToolSearch: 'anthropic',
      pricing: {
        // Cache reads are 0.05x base input on this model, not 0.1x.
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 5,
        inputPerMTok: 4,
        outputPerMTok: 20,
      },
      promptCaching: 'anthropic',
      supportsStreaming: true,
      tagline: 'For long-running agentic coding and knowledge work',
      type: 'llm',
      vision: 'supported',
    });
  });

  /** Global cross-region rate; geo/in-region is 10% higher (see the row's `_note`). */
  it('declares the Bedrock Claude Opus 5.5 route from the AWS model card and pricing page', () => {
    expect(getLlmModelDefinition('bedrock', 'anthropic.claude-opus-5-5')).toEqual({
      bedrockReasoning: 'adaptive',
      contextWindow: 1_000_000,
      id: 'anthropic.claude-opus-5-5',
      label: 'Claude Opus 5.5 (Bedrock)',
      maxOutputTokens: 128_000,
      pricing: {
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 5,
        inputPerMTok: 4,
        outputPerMTok: 20,
      },
      promptCaching: 'bedrock',
      supportsStreaming: true,
      tagline: 'For long-running agentic coding and knowledge work',
      type: 'llm',
      vision: 'supported',
    });
  });

  /**
   * OpenRouter Models API. `reasoning` is mapped key-for-key from the route's
   * published reasoning object and omitted where that object lists no
   * efforts; `inputModalities`/`outputModalities` are recorded only where the
   * payload lists no `file` modality, which the schema cannot carry.
   */
  const OPENROUTER_ROWS: readonly LlmModelDefinition[] = [
    {
      contextWindow: 1_050_000,
      id: 'openai/gpt-6-sol',
      label: 'GPT-6 Sol (OpenRouter)',
      maxOutputTokens: 128_000,
      // BST-1708: gateway long-context tier rides along with the base rate.
      pricing: {
        inputPerMTok: 2,
        longContextTiers: [
          {
            cacheReadPerMTok: 0.4,
            cacheWritePerMTok: 5,
            inputPerMTok: 4,
            minPromptTokens: 272_000,
            outputPerMTok: 15,
          },
        ],
        outputPerMTok: 10,
      },
      reasoning: {
        defaultEffort: 'medium',
        defaultEnabled: true,
        mandatory: false,
        supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 1_050_000,
      id: 'openai/gpt-6-luna',
      label: 'GPT-6 Luna (OpenRouter)',
      maxOutputTokens: 128_000,
      // BST-1708: gateway long-context tier rides along with the base rate.
      pricing: {
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
      },
      reasoning: {
        defaultEffort: 'medium',
        defaultEnabled: true,
        mandatory: false,
        supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 1_000_000,
      id: 'anthropic/claude-opus-5.5',
      label: 'Claude Opus 5.5 (OpenRouter)',
      maxOutputTokens: 128_000,
      pricing: { inputPerMTok: 4, outputPerMTok: 20 },
      reasoning: {
        defaultEffort: 'high',
        mandatory: true,
        supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 500_000,
      id: 'x-ai/grok-4.7',
      label: 'Grok 4.7 (OpenRouter)',
      maxOutputTokens: 450_000,
      // BST-1708: gateway long-context tier rides along with the base rate.
      pricing: {
        inputPerMTok: 1.6,
        longContextTiers: [
          {
            cacheReadPerMTok: 0.8,
            inputPerMTok: 3.2,
            minPromptTokens: 200_000,
            outputPerMTok: 9.6,
          },
        ],
        outputPerMTok: 4.8,
      },
      reasoning: {
        defaultEffort: 'high',
        defaultEnabled: true,
        mandatory: true,
        supportedEfforts: ['xhigh', 'high', 'medium', 'low'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 192_000,
      id: 'cohere/command-a-plus',
      inputModalities: ['text', 'image'],
      label: 'Command A+ (OpenRouter)',
      maxOutputTokens: 64_000,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.3, outputPerMTok: 1.5 },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 1_048_576,
      id: 'xiaomi/mimo-v2.6-pro',
      inputModalities: ['text', 'image', 'video', 'audio'],
      label: 'MiMo-V2.6-Pro (OpenRouter)',
      maxOutputTokens: 131_072,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.435, outputPerMTok: 0.87 },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 1_048_576,
      id: 'xiaomi/mimo-v2.6-flash',
      inputModalities: ['text', 'image', 'video', 'audio'],
      label: 'MiMo-V2.6-Flash (OpenRouter)',
      maxOutputTokens: 131_072,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 1_000_000,
      id: 'qwen/qwen3.8-omni-flash',
      inputModalities: ['text', 'image', 'audio', 'video'],
      label: 'Qwen3.8 Omni Flash (OpenRouter)',
      maxOutputTokens: 131_072,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.15, outputPerMTok: 0.47 },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 1_048_576,
      id: 'z-ai/glm-5.3-flashx',
      inputModalities: ['text', 'image', 'video'],
      label: 'GLM 5.3 FlashX (OpenRouter)',
      maxOutputTokens: 131_072,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.37, outputPerMTok: 1.25 },
      reasoning: {
        defaultEffort: 'max',
        defaultEnabled: true,
        mandatory: true,
        supportedEfforts: ['max', 'high', 'low'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 1_048_576,
      id: 'meta/muse-spark-1.3-contributor',
      label: 'Muse Spark 1.3 Contributor (OpenRouter)',
      maxOutputTokens: 943_718,
      pricing: { inputPerMTok: 0.1, outputPerMTok: 0.2 },
      reasoning: {
        defaultEffort: 'medium',
        mandatory: true,
        supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 131_072,
      id: 'meta/muse-glimmer-30b',
      inputModalities: ['text', 'image'],
      label: 'Muse Glimmer 30B (OpenRouter)',
      maxOutputTokens: 16_384,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
      reasoning: {
        defaultEffort: 'medium',
        mandatory: true,
        supportedEfforts: ['xhigh', 'high', 'medium', 'low'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 524_288,
      id: 'thinkingmachines/inkling-small',
      inputModalities: ['text', 'image', 'audio'],
      label: 'Inkling Small (OpenRouter)',
      maxOutputTokens: 262_144,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.45, outputPerMTok: 1.2 },
      reasoning: {
        defaultEffort: 'high',
        defaultEnabled: true,
        mandatory: false,
        supportedEfforts: ['max', 'high', 'medium', 'low', 'minimal', 'none'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 262_144,
      id: 'bytedance-seed/seed-2-1-turbo',
      inputModalities: ['text', 'image', 'video'],
      label: 'Seed 2.1 Turbo (OpenRouter)',
      maxOutputTokens: 235_929,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.5, outputPerMTok: 2.5 },
      supportsStreaming: true,
      type: 'llm',
      vision: 'supported',
    },
    {
      contextWindow: 202_800,
      id: 'nvidia/nemotron-3-ultra-550b-a55b',
      inputModalities: ['text'],
      label: 'Nemotron 3 Ultra (OpenRouter)',
      maxOutputTokens: 182_520,
      outputModalities: ['text'],
      pricing: { inputPerMTok: 0.6, outputPerMTok: 2.4 },
      reasoning: {
        defaultEffort: 'high',
        defaultEnabled: true,
        mandatory: false,
        supportedEfforts: ['high', 'medium'],
      },
      supportsStreaming: true,
      type: 'llm',
      vision: 'unsupported',
    },
  ];

  it.each(OPENROUTER_ROWS.map((row) => [row.id, row] as const))(
    'declares openrouter/%s from the OpenRouter Models API',
    (id, expected) => {
      expect(getLlmModelDefinition('openrouter', id)).toEqual(expected);
    }
  );

  it('records the top_provider context window, not a single-provider model-level one', () => {
    // Model-level context_length is 1_310_720, served only by Cloudflare.
    const flash = getLlmModelDefinition('openrouter', 'deepseek/deepseek-v4-flash-0731');
    expect(flash?.contextWindow).toBe(1_048_576);
    expect(flash?.maxOutputTokens).toBe(943_718);
  });

  it('promotes none of the new rows to a default or the OpenRouter seed set', () => {
    expect(resolveDefaultModel('openai')).toBe('gpt-5.6-terra');
    expect(resolveDefaultModel('anthropic')).toBe('claude-sonnet-5');
    expect(resolveDefaultModel('bedrock')).toBe('anthropic.claude-sonnet-5');
    expect(resolveDefaultModel('openrouter')).toBe('openai/gpt-5.6-terra');
    const seeded: readonly string[] = OPENROUTER_RECOMMENDED_CODING_MODEL_IDS;
    for (const row of OPENROUTER_ROWS) {
      expect(seeded).not.toContain(row.id);
    }
  });
});
