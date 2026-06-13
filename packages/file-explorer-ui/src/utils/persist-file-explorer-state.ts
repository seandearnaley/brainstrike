import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState, SerializedState } from '@brainstrike/types';
import type { StoreApi } from 'zustand';
import type { UseBoundStoreWithEqualityFn } from 'zustand/traditional';

export interface PersistOptions {
  name?: string;
  partialize?: (state: FileExplorerState) => SerializedState;
  version?: number;
}

export type PersistableFileExplorerStore = Pick<
  UseBoundStoreWithEqualityFn<StoreApi<FileExplorerState>>,
  'getState'
> & {
  persist?: {
    getOptions: () => PersistOptions;
    hasHydrated?: () => boolean;
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
  // CLOBBER GUARD: serializing the store before rehydration writes DEFAULT
  // state (default filters, default cap, empty selections) over the user's
  // persisted data — the historical cause of "my settings reverted on
  // reload". Refuse loudly instead.
  if (typeof persistApi.hasHydrated === 'function' && !persistApi.hasHydrated()) {
    throw new Error(
      'Refusing to persist file explorer state before rehydration — it would overwrite stored state with defaults.'
    );
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
