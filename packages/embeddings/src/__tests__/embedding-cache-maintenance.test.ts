import { describe, expect, it, vi } from 'vitest';
import { EmbeddingCacheMaintenanceController } from '../worker/embedding-cache-maintenance';
import type { EmbeddingCacheInterface } from '../worker/embedding-worker';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('EmbeddingCacheMaintenanceController', () => {
  it('keeps a concurrent cache write dirty when it resolves during maintenance', async () => {
    const firstMaintenance = deferred<{ needed: boolean; evicted: number; totalEntries: number }>();
    const cache: EmbeddingCacheInterface = {
      evictIfNeeded: vi.fn(() => firstMaintenance.promise),
      get: async () => ({ hit: false, entry: null }),
      getBatch: async () => new Map(),
      getStats: vi.fn(async () => ({
        newestAccessedAt: null,
        oldestAccessedAt: null,
        totalEntries: 1,
        totalHits: 0,
      })),
      set: async () => {},
      setBatch: async () => 0,
    };
    const log = vi.fn();
    const warn = vi.fn();
    const evictIfNeeded = cache.evictIfNeeded;
    if (!evictIfNeeded) {
      throw new Error('Expected evictIfNeeded to be defined.');
    }
    const controller = new EmbeddingCacheMaintenanceController(cache, { log, warn });

    controller.trackCacheWrite(Promise.resolve(1));
    await controller.flushPendingWrites();

    const maintenance = controller.run('queue-idle');
    await Promise.resolve();
    expect(cache.evictIfNeeded).toHaveBeenCalledTimes(1);

    controller.trackCacheWrite(Promise.resolve(1));
    await controller.flushPendingWrites();
    firstMaintenance.resolve({ evicted: 0, needed: false, totalEntries: 1 });
    await maintenance;

    expect(evictIfNeeded).toHaveBeenCalledTimes(1);

    vi.mocked(evictIfNeeded).mockResolvedValue({
      evicted: 0,
      needed: false,
      totalEntries: 2,
    });

    await controller.run('queue-idle');

    expect(evictIfNeeded).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
