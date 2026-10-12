// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createRegistry, createStorage, rootHandle } from './workspace-root-registry-test-helpers';

it('synchronously reserves the actual mount and rejects late borrows/mutations without deadlocking source shutdown', async () => {
  const registry = createRegistry();
  const root = await registry.addRoot(rootHandle('/owned'));
  const borrowed = await registry.borrowSourceRoot(root.rootId, async () => {
    throw new Error('Never subscribed');
  });
  const reservation = registry.reserveRootDataDeletion(root.rootId);
  await expect(
    borrowed.listDir('.', 10, { requestId: 'late-read', signal: new AbortController().signal })
  ).rejects.toThrow('revoked or replaced');
  const held = Promise.withResolvers<void>();
  const active = reservation.run(async () => {
    await held.promise;
  });
  await expect(registry.restoreRoots()).rejects.toThrow('deletion owns');
  await expect(registry.removeRoot(root.rootId)).rejects.toThrow('deletion owns');
  await expect(
    registry.borrowSourceRoot(root.rootId, async () => {
      throw new Error('Never subscribed');
    })
  ).rejects.toThrow('deletion owns');
  held.resolve();
  await active;
  await reservation.run(async () => {
    await reservation.retireSources();
    await reservation.disconnect();
  });
  reservation.release();
  expect(await registry.restoreRoots()).toEqual([]);
  await registry.dispose();
});

it('retains the exact failed source cleanup reservation for retry and refuses foreign IDs', async () => {
  const evict = vi.fn(async () => undefined);
  const registry = createRegistry({ evictLspServersForRoot: evict });
  const root = await registry.addRoot(rootHandle('/owned'));
  const other = await registry.addRoot(rootHandle('/other'));
  const reservation = registry.reserveRootDataDeletion(root.rootId);
  evict.mockRejectedValueOnce(new Error('LSP cleanup failed'));
  await expect(reservation.run(() => reservation.retireSources())).rejects.toThrow(
    'resource cleanup failed'
  );
  await expect(registry.removeRoot(other.rootId)).rejects.toThrow('deletion owns');
  expect(() => registry.reserveRootDataDeletion(other.rootId)).toThrow('already owns');
  await reservation.run(async () => {
    await reservation.retireSources();
    await reservation.disconnect();
  });
  reservation.release();
  expect((await registry.restoreRoots()).map((entry) => entry.rootId)).toEqual([other.rootId]);
  expect(() => registry.reserveRootDataDeletion('foreign')).toThrow('actually mounted');
  await registry.dispose();
});

it('refuses the captured original mount if an already-admitted disconnect retires it', async () => {
  const storage = createStorage();
  const registry = createRegistry({ storage });
  const root = await registry.addRoot(rootHandle('/owned'));
  const originalRead = storage.getItem.bind(storage);
  const held = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  vi.spyOn(storage, 'getItem').mockImplementationOnce(async (key) => {
    reading.resolve();
    await held.promise;
    return originalRead(key);
  });
  const admitted = registry.removeRoot(root.rootId);
  await reading.promise;
  const reservation = registry.reserveRootDataDeletion(root.rootId);
  const mutation = vi.fn(async () => undefined);
  const deletion = reservation.run(mutation);
  held.resolve();
  await admitted;
  await expect(deletion).rejects.toThrow('replaced or retired');
  expect(mutation).not.toHaveBeenCalled();
  reservation.release();
  await registry.dispose();
});
