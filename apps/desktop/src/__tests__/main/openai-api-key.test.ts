import { describe, expect, it, vi } from 'vitest';

const readProviderApiKey = vi.fn().mockResolvedValue('api-key');

vi.mock('../../provider-api-key', () => ({
  readProviderApiKey: (...args: [string]) => readProviderApiKey(...args),
}));

import { readOpenAIApiKey } from '../../openai-api-key';

describe('openai-api-key', () => {
  it('delegates to readProviderApiKey', async () => {
    const value = await readOpenAIApiKey();
    expect(readProviderApiKey).toHaveBeenCalledWith('openai');
    expect(value).toBe('api-key');
  });
});
