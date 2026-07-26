import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeData } from '../index';
import { isSupportedProvider, resolveProviderApiKey } from '../providers/key-resolver';

describe('key-resolver', () => {
  const originalEnv = process.env;
  const providerEnvKeys = [
    'AI_ANTHROPIC_API_KEY',
    'AI_GOOGLE_GENERATIVE_AI_API_KEY',
    'AI_OPENAI_API_KEY',
    'AI_OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
  ] as const;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const envKey of providerEnvKeys) {
      delete process.env[envKey];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('resolveProviderApiKey', () => {
    it('returns API key from runtime data if provided', () => {
      const runtime: RuntimeData = {
        apiKey: 'runtime-key-123',
      };
      expect(resolveProviderApiKey('openai', runtime)).toBe('runtime-key-123');
    });

    it('returns undefined if runtime key is empty string', () => {
      const runtime: RuntimeData = {
        apiKey: '   ',
      };
      // Should fall through to env vars
      expect(resolveProviderApiKey('openai', runtime)).toBeUndefined();
    });

    it('resolves OpenAI key from OPENAI_API_KEY env var', () => {
      process.env['OPENAI_API_KEY'] = 'env-openai-key';
      expect(resolveProviderApiKey('openai')).toBe('env-openai-key');
    });

    it('resolves OpenAI key from AI_OPENAI_API_KEY env var', () => {
      process.env['AI_OPENAI_API_KEY'] = 'env-openai-key-2';
      expect(resolveProviderApiKey('openai')).toBe('env-openai-key-2');
    });

    it('resolves Anthropic key from ANTHROPIC_API_KEY env var', () => {
      process.env['ANTHROPIC_API_KEY'] = 'env-anthropic-key';
      expect(resolveProviderApiKey('anthropic')).toBe('env-anthropic-key');
    });

    it('resolves Google key from GOOGLE_GENERATIVE_AI_API_KEY env var', () => {
      process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = 'env-google-key';
      expect(resolveProviderApiKey('google')).toBe('env-google-key');
    });

    it('resolves OpenRouter key from OPENROUTER_API_KEY env var', () => {
      process.env['OPENROUTER_API_KEY'] = 'env-openrouter-key';
      expect(resolveProviderApiKey('openrouter')).toBe('env-openrouter-key');
    });

    it('prefers runtime key over environment variables', () => {
      process.env['OPENAI_API_KEY'] = 'env-key';
      const runtime: RuntimeData = {
        apiKey: 'runtime-key',
      };
      expect(resolveProviderApiKey('openai', runtime)).toBe('runtime-key');
    });

    it('returns undefined for unsupported provider with no env vars', () => {
      expect(resolveProviderApiKey('unsupported')).toBeUndefined();
    });

    it('trims whitespace from environment variable values', () => {
      process.env['OPENAI_API_KEY'] = '  env-key-with-spaces  ';
      expect(resolveProviderApiKey('openai')).toBe('env-key-with-spaces');
    });

    it('tries multiple env var variants in order', () => {
      // Set only the second variant
      process.env['AI_OPENAI_API_KEY'] = 'second-variant';
      expect(resolveProviderApiKey('openai')).toBe('second-variant');

      // First variant takes precedence
      process.env['OPENAI_API_KEY'] = 'first-variant';
      expect(resolveProviderApiKey('openai')).toBe('first-variant');
    });
  });

  describe('isSupportedProvider', () => {
    it('returns true for openai', () => {
      expect(isSupportedProvider('openai')).toBe(true);
    });

    it('returns true for anthropic', () => {
      expect(isSupportedProvider('anthropic')).toBe(true);
    });

    it('returns true for google', () => {
      expect(isSupportedProvider('google')).toBe(true);
    });

    it('returns true for openrouter', () => {
      expect(isSupportedProvider('openrouter')).toBe(true);
    });

    it('returns false for unsupported provider', () => {
      expect(isSupportedProvider('unsupported')).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isSupportedProvider(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isSupportedProvider('')).toBe(false);
    });
  });
});
