import { describe, expect, it } from 'vitest';
import { GEMMA4_E2B_MODEL_ID } from '../local-llm.js';
import { getLlmModelDefinition, listProviders } from '../provider-registry.js';

describe('vision (image input) metadata', () => {
  it('every static LLM model declares vision explicitly, never as unknown', () => {
    // 'unknown' is reserved for dynamically discovered local-runtime models;
    // statically registered models are researched facts and must commit to
    // 'supported' or 'unsupported' so the composer gate never guesses.
    for (const provider of listProviders()) {
      for (const model of provider.models) {
        if (model.type === 'llm') {
          expect(['supported', 'unsupported'], `${provider.id}/${model.id}`).toContain(
            model.vision
          );
        }
      }
    }
  });

  it('marks the multimodal hosted frontier families as vision-capable', () => {
    expect(getLlmModelDefinition('anthropic', 'claude-sonnet-5').vision).toBe('supported');
    expect(getLlmModelDefinition('openai', 'gpt-5.6-terra').vision).toBe('supported');
    expect(getLlmModelDefinition('google', 'gemini-3.5-flash').vision).toBe('supported');
    expect(getLlmModelDefinition('openrouter', 'anthropic/claude-sonnet-5').vision).toBe(
      'supported'
    );
  });

  it('marks text-only models as vision-unsupported', () => {
    // The built-in browser runtime is text-only regardless of the Gemma
    // architecture's multimodal variants — the transformers.js pipeline
    // accepts no image parts.
    expect(getLlmModelDefinition('local', GEMMA4_E2B_MODEL_ID).vision).toBe('unsupported');
    expect(getLlmModelDefinition('openrouter', 'qwen/qwen3-coder-next').vision).toBe('unsupported');
    expect(getLlmModelDefinition('openrouter', 'moonshotai/kimi-k2.6').vision).toBe('unsupported');
    expect(getLlmModelDefinition('openrouter', 'z-ai/glm-5.2').vision).toBe('unsupported');
  });
});
