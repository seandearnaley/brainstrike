import { describe, expect, it, vi } from 'vitest';
import { startEmbeddingWorker } from '../index';

describe('embedding-worker disabled mode', () => {
  it('returns a no-op controller when disabled', async () => {
    const log = vi.fn();
    const controller = await startEmbeddingWorker({
      // @ts-expect-error minimal stub with query to satisfy interface
      db: { query: vi.fn(async () => ({ rows: [] })) },
      enable: false,
      log,
    });
    expect(typeof controller.stop).toBe('function');
    await controller.stop();
    expect(log).toHaveBeenCalledWith('Embedding worker disabled via EMBED_QUEUE_ENABLED=false');
  });
});
