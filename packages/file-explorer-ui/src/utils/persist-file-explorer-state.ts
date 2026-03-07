import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState, SerializedState } from '@brainstrike/types';
import type { StoreApi } from 'zustand';
import type { UseBoundStoreWithEqualityFn } from 'zustand/traditional';

interface PersistOptions {
  name?: string;
  partialize?: (state: FileExplorerState) => SerializedState;
  version?: number;
}

type PersistableFileExplorerStore = Pick<
  UseBoundStoreWithEqualityFn<StoreApi<FileExplorerState>>,
  'getState'
> & {
  persist?: {
    getOptions: () => PersistOptions;
  };
};

export async function persistFileExplorerStateImmediately(
  store: PersistableFileExplorerStore,
  storageAdapter: StorageAdapter
): Promise<void> {
  const persistApi = store.persist;
  if (!persistApi) {
    throw new Error('File explorer persist API is unavailable');
  }

  const options = persistApi.getOptions();
  if (!options.name) {
    throw new Error('File explorer persistence key is missing');
  }

  const state = store.getState();
  const snapshot = {
    state: options.partialize ? options.partialize(state) : (state as unknown as SerializedState),
    version: options.version ?? 0,
  };
  await storageAdapter.setItem(options.name, JSON.stringify(snapshot));
}
