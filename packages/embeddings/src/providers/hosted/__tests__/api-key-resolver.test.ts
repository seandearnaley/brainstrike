import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHostedProviderApiKeyCache, resolveHostedProviderApiKey } from '../api-key-resolver';

// Store original values to restore after tests
const originalProcess = globalThis.process;
const originalWindow = globalThis.window;

describe('api-key-resolver', () => {
  beforeEach(() => {
    // Clear cache before each test
    clearHostedProviderApiKeyCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original globals
    if (originalProcess) {
      globalThis.process = originalProcess;
    } else {
      (globalThis as { process?: unknown }).process = undefined;
    }

    if (originalWindow) {
      globalThis.window = originalWindow;
    } else {
      (globalThis as { window?: unknown }).window = undefined;
    }

    // Clear cache after each test
    clearHostedProviderApiKeyCache();
  });

  describe('cache management', () => {
    it('returns cached key on second call', async () => {
      // Setup process.env with a key
      globalThis.process = {
        env: { OPENAI_API_KEY: 'test-key-123' },
      } as unknown as NodeJS.Process;

      const firstResult = await resolveHostedProviderApiKey('openai');
      expect(firstResult).toBe('test-key-123');

      // Change the environment variable
      (globalThis.process as NodeJS.Process).env['OPENAI_API_KEY'] = 'different-key';

      // Should still return cached value
      const secondResult = await resolveHostedProviderApiKey('openai');
      expect(secondResult).toBe('test-key-123');
    });

    it('clears cache for specific provider', async () => {
      globalThis.process = {
        env: {
          GOOGLE_API_KEY: 'google-key',
          OPENAI_API_KEY: 'openai-key',
        },
      } as unknown as NodeJS.Process;

      const openaiKey1 = await resolveHostedProviderApiKey('openai');
      const googleKey1 = await resolveHostedProviderApiKey('google');
      expect(openaiKey1).toBe('openai-key');
      expect(googleKey1).toBe('google-key');

      // Change OpenAI key and clear its cache
      (globalThis.process as NodeJS.Process).env['OPENAI_API_KEY'] = 'new-openai-key';
      clearHostedProviderApiKeyCache('openai');

      const openaiKey2 = await resolveHostedProviderApiKey('openai');
      const googleKey2 = await resolveHostedProviderApiKey('google');

      expect(openaiKey2).toBe('new-openai-key'); // New value after cache clear
      expect(googleKey2).toBe('google-key'); // Still cached
    });

    it('clears cache for all providers when no provider specified', async () => {
      globalThis.process = {
        env: {
          GOOGLE_API_KEY: 'google-key',
          OPENAI_API_KEY: 'openai-key',
        },
      } as unknown as NodeJS.Process;

      await resolveHostedProviderApiKey('openai');
      await resolveHostedProviderApiKey('google');

      // Change keys and clear all caches
      (globalThis.process as NodeJS.Process).env['OPENAI_API_KEY'] = 'new-openai';
      (globalThis.process as NodeJS.Process).env['GOOGLE_API_KEY'] = 'new-google';
      clearHostedProviderApiKeyCache();

      const openaiKey = await resolveHostedProviderApiKey('openai');
      const googleKey = await resolveHostedProviderApiKey('google');

      expect(openaiKey).toBe('new-openai');
      expect(googleKey).toBe('new-google');
    });
  });

  describe('secrets API fallback chain', () => {
    it('returns key from secrets API when available', async () => {
      const mockGetKey = vi.fn().mockResolvedValue('secret-api-key');

      globalThis.window = {
        secrets: { getKey: mockGetKey },
      } as unknown as Window & typeof globalThis;

      const result = await resolveHostedProviderApiKey('openai');

      expect(mockGetKey).toHaveBeenCalledWith('openai');
      expect(result).toBe('secret-api-key');
    });

    it('falls back to process.env when secrets API returns null', async () => {
      const mockGetKey = vi.fn().mockResolvedValue(null);

      globalThis.window = {
        secrets: { getKey: mockGetKey },
      } as unknown as Window & typeof globalThis;

      globalThis.process = {
        env: { OPENAI_API_KEY: 'process-env-key' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(mockGetKey).toHaveBeenCalledWith('openai');
      expect(result).toBe('process-env-key');
    });

    it('falls back to process.env when secrets API throws', async () => {
      const mockGetKey = vi.fn().mockRejectedValue(new Error('Secrets API error'));

      globalThis.window = {
        secrets: { getKey: mockGetKey },
      } as unknown as Window & typeof globalThis;

      globalThis.process = {
        env: { OPENAI_API_KEY: 'process-env-key' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(mockGetKey).toHaveBeenCalledWith('openai');
      expect(result).toBe('process-env-key');
    });

    it('returns undefined when both secrets and process.env are unavailable', async () => {
      (globalThis as { window?: unknown }).window = undefined;
      globalThis.process = { env: {} } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      // Without secrets API or process.env, should fall back to import.meta.env or return undefined
      // import.meta.env is not easily mockable in tests, so we just verify fallback behavior
      expect(result).toBeUndefined();
    });
  });

  describe('process.env resolution', () => {
    it('checks environment variables in priority order for OpenAI', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: {
          BRAINSTRIKE_OPENAI_API_KEY: 'brainstrike-key',
          OPENAI_API_KEY: 'standard-key',
        },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      // Should return BRAINSTRIKE_OPENAI_API_KEY as it comes first in priority
      expect(result).toBe('brainstrike-key');
    });

    it('checks VITE_ prefixed variants', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: {
          VITE_OPENAI_API_KEY: 'vite-key',
        },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBe('vite-key');
    });

    it('handles Google provider environment variables', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: {
          GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
        },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('google');

      expect(result).toBe('google-key');
    });

    it('handles Cohere provider environment variables', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: {
          COHERE_API_KEY: 'cohere-key',
        },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('cohere');

      expect(result).toBe('cohere-key');
    });

    it('handles Voyage provider environment variables', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: {
          VOYAGE_API_KEY: 'voyage-key',
        },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('voyage');

      expect(result).toBe('voyage-key');
    });

    it('handles Ollama provider environment variables', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: {
          OLLAMA_API_KEY: 'ollama-key',
        },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('ollama');

      expect(result).toBe('ollama-key');
    });

    it('handles LM Studio provider environment variables', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: {
          LMSTUDIO_API_KEY: 'lmstudio-key',
        },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('lmstudio');

      expect(result).toBe('lmstudio-key');
    });

    it('returns undefined when no environment variable found', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: {},
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });

    it('handles missing process object gracefully', async () => {
      (globalThis as { window?: unknown }).window = undefined;
      (globalThis as { process?: unknown }).process = undefined;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });
  });

  describe('import.meta.env resolution', () => {
    // Note: import.meta.env is read-only and cannot be mocked in tests reliably.
    // The actual implementation handles import.meta.env as a fallback, but we test
    // the behavior indirectly through integration tests and by ensuring the code
    // doesn't crash when import.meta is unavailable.

    it('handles missing import.meta.env gracefully', async () => {
      (globalThis as { window?: unknown }).window = undefined;
      globalThis.process = { env: {} } as unknown as NodeJS.Process;

      // The function should not throw even if import.meta.env is unavailable
      const result = await resolveHostedProviderApiKey('openai');

      // Without any sources, should return undefined
      expect(result).toBeUndefined();
    });

    it('does not crash when import.meta is in unexpected state', async () => {
      (globalThis as { window?: unknown }).window = undefined;
      (globalThis as { process?: unknown }).process = undefined;

      // Should handle gracefully even in edge cases
      await expect(resolveHostedProviderApiKey('openai')).resolves.toBeUndefined();
    });
  });

  describe('value normalization', () => {
    it('trims whitespace from values', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: { OPENAI_API_KEY: '  key-with-spaces  ' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBe('key-with-spaces');
    });

    it('treats empty string as undefined', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: { OPENAI_API_KEY: '' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });

    it('treats whitespace-only string as undefined', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: { OPENAI_API_KEY: '   ' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });

    it('handles non-string values as undefined', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: { OPENAI_API_KEY: 123 as unknown as string },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });

    it('handles null values as undefined', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: { OPENAI_API_KEY: null as unknown as string },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });

    it('handles undefined values', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: { OPENAI_API_KEY: undefined },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });
  });

  describe('priority order across sources', () => {
    it('prefers secrets API over process.env', async () => {
      const mockGetKey = vi.fn().mockResolvedValue('secrets-key');

      globalThis.window = {
        secrets: { getKey: mockGetKey },
      } as unknown as Window & typeof globalThis;

      globalThis.process = {
        env: { OPENAI_API_KEY: 'process-key' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBe('secrets-key');
    });

    it('prefers process.env when available', async () => {
      (globalThis as { window?: unknown }).window = undefined;

      globalThis.process = {
        env: { OPENAI_API_KEY: 'process-key' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      // process.env should be used when available
      expect(result).toBe('process-key');
    });

    it('returns undefined when all sources fail', async () => {
      (globalThis as { window?: unknown }).window = undefined;
      globalThis.process = { env: {} } as unknown as NodeJS.Process;
      (import.meta as { env?: unknown }).env = undefined;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles secrets API without getKey method', async () => {
      globalThis.window = {
        secrets: {},
      } as unknown as Window & typeof globalThis;

      globalThis.process = {
        env: { OPENAI_API_KEY: 'fallback-key' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBe('fallback-key');
    });

    it('handles window object without secrets property', async () => {
      globalThis.window = {} as Window & typeof globalThis;

      globalThis.process = {
        env: { OPENAI_API_KEY: 'fallback-key' },
      } as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBe('fallback-key');
    });

    it('handles process object without env property', async () => {
      (globalThis as { window?: unknown }).window = undefined;
      globalThis.process = {} as unknown as NodeJS.Process;

      const result = await resolveHostedProviderApiKey('openai');

      expect(result).toBeUndefined();
    });
  });
});
