import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupTempDirs,
  makeService,
  makeSingleRepoRoot,
  makeWorktreeListRunner,
} from './git-inventory-service-test-support.ts';

afterEach(cleanupTempDirs);

async function startService(stop: () => Promise<void>) {
  const { fs, rootDir, rootId } = await makeSingleRepoRoot('brainstrike-git-retirement-');
  const watchDirectory = vi.fn(() => Promise.resolve(stop));
  const service = makeService({
    fs,
    loadRoots: () => Promise.resolve([{ id: rootId, path: rootDir }]),
    run: makeWorktreeListRunner(),
    watchDirectory,
  });
  service.start();
  await service.getSnapshot();
  expect(watchDirectory).toHaveBeenCalledOnce();
  return { service, watchDirectory };
}

describe('Git inventory service retains physical watcher retirement (BST-2248)', () => {
  it('retries a rejected stop and joins concurrent calls until the native unsubscribe settles', async () => {
    const failure = new Error('Native unsubscribe failed');
    const held = Promise.withResolvers<void>();
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(held.promise);
    const { service } = await startService(stop);
    await expect(service.stop()).rejects.toMatchObject({ errors: [failure] });

    let settled = false;
    const retry = service.stop().then(() => {
      settled = true;
    });
    const concurrent = service.stop().then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
    } finally {
      held.resolve();
      await Promise.all([retry, concurrent]);
    }
    await service.stop();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('reports every failed repeat stop and refuses a replacement until retirement succeeds', async () => {
    const failure = new Error('Native watcher is still owned');
    const stop = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const { service, watchDirectory } = await startService(stop);
    try {
      await expect(service.stop()).rejects.toMatchObject({ errors: [failure] });
      expect(() => service.start()).toThrow(/retirement/iu);
      await expect(service.stop()).rejects.toMatchObject({ errors: [failure] });
      expect(stop).toHaveBeenCalledTimes(2);
      expect(watchDirectory).toHaveBeenCalledOnce();
    } finally {
      stop.mockResolvedValue(undefined);
      await service.stop();
    }
    service.start();
    await service.getSnapshot();
    expect(watchDirectory).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it('refuses restart while the previous stop is joining the physical unsubscribe', async () => {
    const held = Promise.withResolvers<void>();
    const stop = vi.fn(() => held.promise);
    const { service } = await startService(stop);
    const retiring = service.stop();
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(() => service.start()).toThrow(/retirement/iu);
    } finally {
      held.resolve();
      await retiring;
      await service.stop();
    }
  });
});
