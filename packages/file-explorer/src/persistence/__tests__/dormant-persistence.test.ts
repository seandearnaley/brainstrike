import { MemoryStorageAdapter } from '@brainstrike/storage';
import { expect, it, vi } from 'vitest';
import { createFileExplorerStore } from '../../store';
import * as worker from '../worker-init';

it('dormant persistence starts neither worker acquisition nor storage reads before activation', async () => {
  const storage = new MemoryStorageAdapter();
  const initialize = vi.spyOn(worker, 'initWorker');
  const read = vi.spyOn(storage, 'getItem');
  const store = createFileExplorerStore(storage, { skipHydration: true });
  expect(store.persist.hasHydrated()).toBe(false);
  expect(initialize).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await store.persist.rehydrate();
  expect(store.persist.hasHydrated()).toBe(true);
  expect(initialize).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  initialize.mockRestore();
});

it('retiring a dormant owner does not initialize its worker or read storage', async () => {
  const storage = new MemoryStorageAdapter();
  const initialize = vi.spyOn(worker, 'initWorker');
  const read = vi.spyOn(storage, 'getItem');
  const store = createFileExplorerStore(storage, { skipHydration: true });
  await store.preparePersistenceClose();
  await expect(Promise.resolve().then(() => store.persist.rehydrate())).rejects.toThrow(
    'preparing to close'
  );
  expect(initialize).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  initialize.mockRestore();
});
