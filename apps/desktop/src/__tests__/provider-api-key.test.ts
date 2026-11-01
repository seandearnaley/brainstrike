import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listConfiguredProviders, resolveProviderEnvCredential } from '../provider-api-key';
import { getSecretsService } from '../secrets';

vi.mock('../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secrets')>();
  return {
    ...actual,
    getSecretsService: vi.fn(),
  };
});

describe('provider credentials', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('environment variable reading', () => {
    it('should return API key from BRAINSTRIKE_OPENAI_API_KEY', () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'test-key-1';
      const result = resolveProviderEnvCredential('openai')?.value;
      expect(result).toBe('test-key-1');
    });

    it('should return API key from OPENAI_API_KEY when BRAINSTRIKE_OPENAI_API_KEY is not set', () => {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_OPENAI_API_KEY');
      process.env['OPENAI_API_KEY'] = 'test-key-3';
      const result = resolveProviderEnvCredential('openai')?.value;
      expect(result).toBe('test-key-3');
    });

    it('never resolves a deprecated env name (BST-1361)', () => {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_OPENAI_API_KEY');
      Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      process.env['BS_OPENAI_API_KEY'] = 'legacy-1';
      process.env['AI_OPENAI_API_KEY'] = 'legacy-2';
      process.env['OPENAI_API_KEY_V1'] = 'legacy-3';
      process.env['OPENAI_API_KEY_V2'] = 'legacy-4';

      const result = resolveProviderEnvCredential('openai')?.value;
      expect(result).toBeUndefined();
    });

    it('should trim whitespace from environment variable values', () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = '  test-key-trimmed  ';
      const result = resolveProviderEnvCredential('openai')?.value;
      expect(result).toBe('test-key-trimmed');
    });

    it('should skip empty string environment variables', () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = '   ';
      process.env['OPENAI_API_KEY'] = 'valid-key';
      const result = resolveProviderEnvCredential('openai')?.value;
      expect(result).toBe('valid-key');
    });

    it('should skip non-string environment variables', () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = undefined as unknown as string;
      process.env['OPENAI_API_KEY'] = 'valid-key';
      const result = resolveProviderEnvCredential('openai')?.value;
      expect(result).toBe('valid-key');
    });

    it('should prioritize env vars in order: BRAINSTRIKE_, then OPENAI_', () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'priority-1';
      process.env['OPENAI_API_KEY'] = 'priority-3';
      const result = resolveProviderEnvCredential('openai')?.value;
      expect(result).toBe('priority-1');
    });
  });

  describe('provider registry helpers', () => {
    it('resolves environment key for google provider', () => {
      process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = '  google-key ';
      expect(resolveProviderEnvCredential('google')?.value).toBe('google-key');
    });

    it('lists providers from both env and stored secrets', async () => {
      process.env['OPENAI_API_KEY'] = 'env-openai';
      // BST-1352: availability inspection reads the TYPED credential; a blank
      // legacy api_key still reads as "not configured".
      const mockGetCredential = vi
        .fn()
        .mockImplementation(async (provider: string) =>
          provider === 'anthropic'
            ? { key: 'secret', type: 'api_key' }
            : { key: '', type: 'api_key' }
        );
      const mockSecretsService = {
        getCredential: mockGetCredential,
        listProviders: vi.fn().mockResolvedValue(['anthropic', 'google']),
      };
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);

      const providers = await listConfiguredProviders();
      expect(providers).toContain('openai');
      expect(providers).toContain('anthropic');
      expect(providers).not.toContain('google');
    });
  });
});
