import { describe, expect, it } from 'vitest';
import { isMastraAgentError } from '../mastra/mastra-agent-error';
import { createProvider, getDefaultModel } from '../providers/provider-factory';

describe('provider-factory', () => {
  describe('createProvider', () => {
    it('creates OpenAI provider with default model', () => {
      const model = createProvider('openai', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-4o-mini');
    });

    it('creates OpenAI provider with custom model', () => {
      const model = createProvider('openai', 'test-key', 'gpt-4') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-4');
    });

    it('creates Anthropic provider with default model', () => {
      const model = createProvider('anthropic', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-3-5-haiku-latest');
    });

    it('creates Anthropic provider with custom model', () => {
      const model = createProvider('anthropic', 'test-key', 'claude-opus-4-1') as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-opus-4-1');
    });

    it('creates Google provider with default model', () => {
      const model = createProvider('google', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemini-2.5-flash');
    });

    it('creates Google provider with custom model', () => {
      const model = createProvider('google', 'test-key', 'gemini-2.5-pro') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemini-2.5-pro');
    });

    it('creates OpenRouter provider with default model', () => {
      const model = createProvider('openrouter', 'test-key') as { modelId: string };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-4o-mini');
    });

    it('creates OpenRouter provider with custom model', () => {
      const model = createProvider('openrouter', 'test-key', 'claude-3-opus') as {
        modelId: string;
      };
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-3-opus');
    });

    it('throws MastraAgentError for unsupported provider', () => {
      try {
        createProvider('unsupported', 'test-key');
        throw new Error('Expected unsupported provider to throw');
      } catch (error) {
        expect(isMastraAgentError(error)).toBe(true);
        if (isMastraAgentError(error)) {
          expect(error.code).toBe('mastra_agent_unsupported_provider');
          expect(error.context).toEqual(
            expect.objectContaining({
              provider: 'unsupported',
              supportedProviders: expect.arrayContaining([
                'openai',
                'anthropic',
                'google',
                'openrouter',
                'local',
              ]),
            })
          );
        }
      }
    });

    it('creates provider without explicit API key (uses env vars)', () => {
      // Should not throw, will rely on environment variables
      const model = createProvider('openai');
      expect(model).toBeDefined();
    });
  });

  describe('getDefaultModel', () => {
    it('returns correct default for OpenAI', () => {
      expect(getDefaultModel('openai')).toBe('gpt-4o-mini');
    });

    it('returns correct default for Anthropic', () => {
      expect(getDefaultModel('anthropic')).toBe('claude-3-5-haiku-latest');
    });

    it('returns correct default for Google', () => {
      expect(getDefaultModel('google')).toBe('gemini-2.5-flash');
    });

    it('returns correct default for OpenRouter', () => {
      expect(getDefaultModel('openrouter')).toBe('gpt-4o-mini');
    });

    it('falls back to OpenAI default for unsupported provider', () => {
      expect(getDefaultModel('unsupported')).toBe('gpt-4o-mini');
    });
  });
});
