import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readOpenAIApiKey } from '../openai-api-key';
import {
  listConfiguredProviders,
  readProviderApiKey,
  readProviderSecretKey,
  resolveProviderEnvKey,
} from '../provider-api-key';
import { getSecretsService } from '../secrets';

vi.mock('../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secrets')>();
  return {
    ...actual,
    getSecretsService: vi.fn(),
  };
});

describe('readOpenAIApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('environment variable reading', () => {
    it('should return API key from BRAINSTRIKE_OPENAI_API_KEY', async () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'test-key-1';
      const result = await readOpenAIApiKey();
      expect(result).toBe('test-key-1');
    });

    it('should return API key from OPENAI_API_KEY when BRAINSTRIKE_OPENAI_API_KEY is not set', async () => {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_OPENAI_API_KEY');
      process.env['OPENAI_API_KEY'] = 'test-key-3';
      const result = await readOpenAIApiKey();
      expect(result).toBe('test-key-3');
    });

    it('never resolves a deprecated env name (BST-1361)', async () => {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_OPENAI_API_KEY');
      Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      process.env['BS_OPENAI_API_KEY'] = 'legacy-1';
      process.env['AI_OPENAI_API_KEY'] = 'legacy-2';
      process.env['OPENAI_API_KEY_V1'] = 'legacy-3';
      process.env['OPENAI_API_KEY_V2'] = 'legacy-4';

      const mockSecretsService = {
        getKey: vi.fn().mockResolvedValue(null),
        listProviders: vi.fn().mockResolvedValue([]),
      };
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);

      const result = await readOpenAIApiKey();
      expect(result).toBeUndefined();
    });

    it('should trim whitespace from environment variable values', async () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = '  test-key-trimmed  ';
      const result = await readOpenAIApiKey();
      expect(result).toBe('test-key-trimmed');
    });

    it('should skip empty string environment variables', async () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = '   ';
      process.env['OPENAI_API_KEY'] = 'valid-key';
      const result = await readOpenAIApiKey();
      expect(result).toBe('valid-key');
    });

    it('should skip non-string environment variables', async () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = undefined as unknown as string;
      process.env['OPENAI_API_KEY'] = 'valid-key';
      const result = await readOpenAIApiKey();
      expect(result).toBe('valid-key');
    });

    it('should prioritize env vars in order: BRAINSTRIKE_, then OPENAI_', async () => {
      process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'priority-1';
      process.env['OPENAI_API_KEY'] = 'priority-3';
      const result = await readOpenAIApiKey();
      expect(result).toBe('priority-1');
    });
  });

  describe('secrets service fallback', () => {
    it('should fallback to secrets service when no env vars are set', async () => {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_OPENAI_API_KEY');
      Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');

      const mockGetKey = vi.fn().mockResolvedValue('secret-key');
      const mockSecretsService = {
        getKey: mockGetKey,
        listProviders: vi.fn().mockResolvedValue(['openai']),
      };
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);

      const result = await readOpenAIApiKey();
      expect(result).toBe('secret-key');
      expect(mockGetKey).toHaveBeenCalledWith('openai');
    });

    it('should return undefined when secrets service returns null', async () => {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_OPENAI_API_KEY');
      Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');

      const mockGetKey = vi.fn().mockResolvedValue(null);
      const mockSecretsService = {
        getKey: mockGetKey,
        listProviders: vi.fn().mockResolvedValue(['openai']),
      };
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);

      const result = await readOpenAIApiKey();
      expect(result).toBeUndefined();
    });

    it('should preserve secrets service failures', async () => {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_OPENAI_API_KEY');
      Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');

      const readError = new Error('Service unavailable');
      vi.mocked(getSecretsService).mockImplementation(() => {
        throw readError;
      });

      await expect(readOpenAIApiKey()).rejects.toBe(readError);
    });

    it('should not use secrets service when env var is present', async () => {
      process.env['OPENAI_API_KEY'] = 'env-key';

      const mockGetKey = vi.fn();
      const mockSecretsService = {
        getKey: mockGetKey,
        listProviders: vi.fn().mockResolvedValue(['openai']),
      };
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);

      const result = await readOpenAIApiKey();
      expect(result).toBe('env-key');
      expect(mockGetKey).not.toHaveBeenCalled();
    });
  });

  describe('provider registry helpers', () => {
    it('resolves environment key for google provider', () => {
      process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = '  google-key ';
      expect(resolveProviderEnvKey('google')).toBe('google-key');
    });

    it('reads provider secret key via secrets service', async () => {
      const mockGetKey = vi.fn().mockResolvedValue('anthropic-secret');
      const mockSecretsService = {
        getKey: mockGetKey,
        listProviders: vi.fn().mockResolvedValue(['anthropic']),
      };
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);
      const key = await readProviderSecretKey('anthropic');
      expect(key).toBe('anthropic-secret');
      expect(mockGetKey).toHaveBeenCalledWith('anthropic');
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

describe('readProviderApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns environment key when available', async () => {
    process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = 'env-google';
    const key = await readProviderApiKey('google');
    expect(key).toBe('env-google');
  });

  it('falls back to secrets when env missing', async () => {
    const mockSecretsService = {
      getKey: vi.fn().mockResolvedValue('stored-key'),
      listProviders: vi.fn().mockResolvedValue(['anthropic']),
    };
    vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);
    const key = await readProviderApiKey('anthropic');
    expect(key).toBe('stored-key');
  });
});
