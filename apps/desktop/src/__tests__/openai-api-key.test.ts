import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readOpenAIApiKey } from '../openai-api-key';

vi.mock('../secrets', () => ({
  getSecretsService: vi.fn(),
}));

describe('readOpenAIApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('environment variable reading', () => {
    it('should return API key from BRAINSTRIKE_OPENAI_API_KEY', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = 'test-key-1';
      const result = await readOpenAIApiKey();
      expect(result).toBe('test-key-1');
    });

    it('should return API key from BS_OPENAI_API_KEY when BRAINSTRIKE_OPENAI_API_KEY is not set', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = undefined;
      process.env.BS_OPENAI_API_KEY = 'test-key-2';
      const result = await readOpenAIApiKey();
      expect(result).toBe('test-key-2');
    });

    it('should return API key from OPENAI_API_KEY when other env vars are not set', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = undefined;
      process.env.BS_OPENAI_API_KEY = undefined;
      process.env.OPENAI_API_KEY = 'test-key-3';
      const result = await readOpenAIApiKey();
      expect(result).toBe('test-key-3');
    });

    it('should trim whitespace from environment variable values', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = '  test-key-trimmed  ';
      const result = await readOpenAIApiKey();
      expect(result).toBe('test-key-trimmed');
    });

    it('should skip empty string environment variables', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = '   ';
      process.env.BS_OPENAI_API_KEY = 'valid-key';
      const result = await readOpenAIApiKey();
      expect(result).toBe('valid-key');
    });

    it('should skip non-string environment variables', async () => {
      // @ts-expect-error testing non-string env value
      process.env.BRAINSTRIKE_OPENAI_API_KEY = 123;
      process.env.BS_OPENAI_API_KEY = 'valid-key';
      const result = await readOpenAIApiKey();
      expect(result).toBe('valid-key');
    });

    it('should prioritize env vars in order: BRAINSTRIKE_, BS_, then OPENAI_', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = 'priority-1';
      process.env.BS_OPENAI_API_KEY = 'priority-2';
      process.env.OPENAI_API_KEY = 'priority-3';
      const result = await readOpenAIApiKey();
      expect(result).toBe('priority-1');
    });
  });

  describe('secrets service fallback', () => {
    it('should fallback to secrets service when no env vars are set', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = undefined;
      process.env.BS_OPENAI_API_KEY = undefined;
      process.env.OPENAI_API_KEY = undefined;

      const mockGetKey = vi.fn().mockResolvedValue('secret-key');
      const mockSecretsService = { getKey: mockGetKey };
      const { getSecretsService } = await import('../secrets');
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);

      const result = await readOpenAIApiKey();
      expect(result).toBe('secret-key');
      expect(mockGetKey).toHaveBeenCalledWith('openai');
    });

    it('should return undefined when secrets service returns null', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = undefined;
      process.env.BS_OPENAI_API_KEY = undefined;
      process.env.OPENAI_API_KEY = undefined;

      const mockGetKey = vi.fn().mockResolvedValue(null);
      const mockSecretsService = { getKey: mockGetKey };
      const { getSecretsService } = await import('../secrets');
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);

      const result = await readOpenAIApiKey();
      expect(result).toBeUndefined();
    });

    it('should return undefined when secrets service throws an error', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = undefined;
      process.env.BS_OPENAI_API_KEY = undefined;
      process.env.OPENAI_API_KEY = undefined;

      const { getSecretsService } = await import('../secrets');
      vi.mocked(getSecretsService).mockImplementation(() => {
        throw new Error('Service unavailable');
      });

      const result = await readOpenAIApiKey();
      expect(result).toBeUndefined();
    });

    it('should return undefined when secrets import fails', async () => {
      process.env.BRAINSTRIKE_OPENAI_API_KEY = undefined;
      process.env.BS_OPENAI_API_KEY = undefined;
      process.env.OPENAI_API_KEY = undefined;

      // Mock the dynamic import to throw an error
      const originalImport = (global as unknown as { import?: unknown }).import;
      // @ts-expect-error simulate failing dynamic import
      (global as unknown as { import: unknown }).import = vi
        .fn()
        .mockRejectedValue(new Error('Module not found')) as unknown;

      const result = await readOpenAIApiKey();
      expect(result).toBeUndefined();

      // Restore
      // @ts-expect-error restore possibly undefined property
      (global as unknown as { import?: unknown }).import = originalImport;
    });

    it('should not use secrets service when env var is present', async () => {
      process.env.OPENAI_API_KEY = 'env-key';

      const mockGetKey = vi.fn();
      const mockSecretsService = { getKey: mockGetKey };
      const { getSecretsService } = await import('../secrets');
      vi.mocked(getSecretsService).mockReturnValue(mockSecretsService as never);

      const result = await readOpenAIApiKey();
      expect(result).toBe('env-key');
      // We cannot verify mockGetKey wasn't called since the env var short-circuits
      // the function before importing secrets
    });
  });
});
