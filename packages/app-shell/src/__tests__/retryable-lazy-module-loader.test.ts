import { describe, expect, it, vi } from 'vitest';
import { createRetryableLazyModuleLoader } from '../retryable-lazy-module-loader';

describe('createRetryableLazyModuleLoader', () => {
  it('reuses the same in-flight promise for concurrent loads', async () => {
    const importer = vi.fn(async () => ({ value: 'loaded' }));
    const loader = createRetryableLazyModuleLoader(importer);

    const [first, second] = await Promise.all([loader.load(), loader.load()]);

    expect(first).toEqual({ value: 'loaded' });
    expect(second).toEqual({ value: 'loaded' });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed import instead of caching the rejection forever', async () => {
    const importer = vi
      .fn<() => Promise<{ value: string }>>()
      .mockRejectedValueOnce(new Error('chunk aborted during navigation'))
      .mockResolvedValueOnce({ value: 'recovered' });
    const loader = createRetryableLazyModuleLoader(importer);

    await expect(loader.load()).rejects.toThrow('chunk aborted during navigation');
    await expect(loader.load()).resolves.toEqual({ value: 'recovered' });
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
