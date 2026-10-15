import { describe, expect, it } from 'vitest';
import { settleDeferredNativeIndexCatalog } from '../native-index-catalog-observation';

function graph(): { queuedCatalogRefresh?: Promise<void> | undefined } {
  return {};
}

describe('settleDeferredNativeIndexCatalog (BST-2012)', () => {
  it('lets a read return at once and applies its queued change once, after the scan settles', async () => {
    const current = graph();
    const scan = Promise.withResolvers<void>();
    let refreshes = 0;
    const refresh = async () => {
      refreshes += 1;
    };
    await settleDeferredNativeIndexCatalog(current, scan.promise, false, refresh, () => {});
    await settleDeferredNativeIndexCatalog(current, scan.promise, false, refresh, () => {});
    expect(refreshes).toBe(0);
    scan.resolve();
    await current.queuedCatalogRefresh;
    expect(refreshes).toBe(1);
    expect(current.queuedCatalogRefresh).toBeUndefined();
  });

  it('runs a joining writer after the queued refresh, never beside it', async () => {
    const current = graph();
    const scan = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const events: string[] = [];
    await settleDeferredNativeIndexCatalog(
      current,
      scan.promise,
      false,
      async () => {
        events.push('queued start');
        await running.promise;
        events.push('queued end');
      },
      () => {}
    );
    const writer = settleDeferredNativeIndexCatalog(
      current,
      scan.promise,
      true,
      async () => {
        events.push('writer');
      },
      () => {}
    );
    scan.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['queued start']);
    running.resolve();
    await writer;
    expect(events).toEqual(['queued start', 'queued end', 'writer']);
  });

  it('reports a failed queued refresh and leaves a failed scan to its own owner', async () => {
    const current = graph();
    const failure = new Error('refresh failed');
    const reported: unknown[] = [];
    await settleDeferredNativeIndexCatalog(
      current,
      Promise.resolve(),
      false,
      async () => {
        throw failure;
      },
      (error) => reported.push(error)
    );
    await current.queuedCatalogRefresh;
    expect(reported).toEqual([failure]);
    let refreshed = false;
    await settleDeferredNativeIndexCatalog(
      current,
      Promise.reject(new Error('scan failed')),
      false,
      async () => {
        refreshed = true;
      },
      (error) => reported.push(error)
    );
    await current.queuedCatalogRefresh;
    expect(refreshed).toBe(false);
    expect(reported).toEqual([failure]);
  });
});
