import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkApiKeyAvailability,
  getApiKeyConfigInstructions,
  requiresApiKey,
} from '../api-key-validation.js';
import { clearHostedProviderApiKeyCache } from '../providers/hosted/api-key-resolver.js';

describe('api-key-validation', () => {
  beforeEach(() => {
    clearHostedProviderApiKeyCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearHostedProviderApiKeyCache();
  });

  describe('requiresApiKey', () => {
    it('returns false for null/undefined model key', () => {
      expect(requiresApiKey(null)).toBe(false);
      expect(requiresApiKey(undefined)).toBe(false);
      expect(requiresApiKey('')).toBe(false);
    });

    it('returns true for hosted providers', () => {
      expect(requiresApiKey('openai::text-embedding-3-small')).toBe(true);
      expect(requiresApiKey('google::gemini-embedding-001')).toBe(true);
      expect(requiresApiKey('cohere::embed-english-v3.0')).toBe(true);
      expect(requiresApiKey('voyage::voyage-3')).toBe(true);
    });

    it('returns false for invalid format', () => {
      expect(requiresApiKey('invalid-format')).toBe(false);
      expect(requiresApiKey('openai::')).toBe(false);
    });
  });

  describe('checkApiKeyAvailability', () => {
    it('returns available for null/undefined model key', async () => {
      const result = await checkApiKeyAvailability(null);
      expect(result.available).toBe(true);
    });

    it('returns available when OpenAI API key is set', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test-key');

      const result = await checkApiKeyAvailability('openai::text-embedding-3-small');
      expect(result.available).toBe(true);
    });

    it('returns not available with message when OpenAI API key is missing', async () => {
      const result = await checkApiKeyAvailability('openai::text-embedding-3-small');

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.provider).toBe('openai');
        expect(result.reason).toBe('missing-provider-key');
        expect(result.message).toContain('OpenAI');
        expect(result.message).toContain('API key');
      }
    });

    it('returns available when Google API key is set', async () => {
      vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-google-key');

      const result = await checkApiKeyAvailability('google::gemini-embedding-001');
      expect(result.available).toBe(true);
    });

    it('returns not available with message when Google API key is missing', async () => {
      const result = await checkApiKeyAvailability('google::gemini-embedding-001');

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.provider).toBe('google');
        expect(result.message).toContain('Google');
      }
    });

    it('returns available when Cohere API key is set', async () => {
      vi.stubEnv('COHERE_API_KEY', 'test-cohere-key');

      const result = await checkApiKeyAvailability('cohere::embed-english-v3.0');
      expect(result.available).toBe(true);
    });

    it('returns available when Voyage API key is set', async () => {
      vi.stubEnv('VOYAGE_API_KEY', 'test-voyage-key');

      const result = await checkApiKeyAvailability('voyage::voyage-3');
      expect(result.available).toBe(true);
    });

    it('surfaces a rename hint when only a deprecated env name is set (BST-1361 review 3)', async () => {
      vi.stubEnv('OPENAI_API_KEY_V2', 'legacy-secret');

      const result = await checkApiKeyAvailability('openai::text-embedding-3-small');

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.message).toContain('OPENAI_API_KEY_V2');
        expect(result.message).toContain('rename');
        expect(result.message).toContain('OPENAI_API_KEY');
        expect(result.message).not.toContain('legacy-secret');
      }
    });

    it('surfaces a rename hint for a VITE_-prefixed deprecated name (BST-1361 review 3)', async () => {
      vi.stubEnv('VITE_GOOGLE_API_KEY', 'legacy-secret');

      const result = await checkApiKeyAvailability('google::gemini-embedding-001');

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.message).toContain('VITE_GOOGLE_API_KEY');
        expect(result.message).toContain('VITE_GOOGLE_GENERATIVE_AI_API_KEY');
      }
    });

    it('never authenticates from a deprecated name, prefixed or not', async () => {
      vi.stubEnv('OPENAI_API_KEY_V2', 'legacy');
      vi.stubEnv('VITE_AI_OPENAI_API_KEY', 'legacy');

      const result = await checkApiKeyAvailability('openai::text-embedding-3-small');
      expect(result.available).toBe(false);
    });
  });

  describe('getApiKeyConfigInstructions', () => {
    it('returns instructions for OpenAI', () => {
      const instructions = getApiKeyConfigInstructions('openai');
      expect(instructions).toContain('OpenAI');
      expect(instructions).toContain('Settings');
      expect(instructions).toContain('OPENAI_API_KEY');
    });

    it('returns instructions for Google', () => {
      const instructions = getApiKeyConfigInstructions('google');
      expect(instructions).toContain('Google');
      expect(instructions).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    });

    it('returns instructions for Cohere', () => {
      const instructions = getApiKeyConfigInstructions('cohere');
      expect(instructions).toContain('Cohere');
      expect(instructions).toContain('COHERE_API_KEY');
    });

    it('returns instructions for Voyage', () => {
      const instructions = getApiKeyConfigInstructions('voyage');
      expect(instructions).toContain('Voyage');
      expect(instructions).toContain('VOYAGE_API_KEY');
    });
  });
});
