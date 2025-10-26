import { describe, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index';

describe('embedding-worker disabled mode', () => {
  it('returns a no-op controller when disabled', async () => {
    const log = vi.fn();
    const controller = await startEmbeddingWorker({
      db: { query: vi.fn(async () => ({ rows: [] })) } as never,
      enable: false,
      log,
    });
    expect(typeof controller.stop).toBe('function');
    await controller.stop();
    expect(log).toHaveBeenCalledWith('Embedding worker disabled via options.enable=false');
  });
});
