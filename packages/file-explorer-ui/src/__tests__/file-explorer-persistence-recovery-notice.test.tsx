/**
 * @vitest-environment happy-dom
 */

import {
  FILE_EXPLORER_STORAGE_KEY,
  FILE_EXPLORER_STORAGE_VERSION,
} from '@brainstrike/file-explorer';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';

const showToast = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useToastManager: () => ({ showToast }),
}));

type ExplorerStore = ReturnType<typeof useFileExplorerStoreContext>;
type PersistCapableExplorerStore = ExplorerStore & {
  persist: { hasHydrated: () => boolean };
};

const validSerializedState = {
  currentFolderId: null,
  expandedDirectoryPaths: [],
  folderAccessOrder: [],
  folderStates: {},
  quickFilter: 'restored-filter',
  selectedFilePaths: [],
};

function StoreCapture({ onStore }: { onStore: (store: ExplorerStore) => void }) {
  const store = useFileExplorerStoreContext();
  useEffect(() => onStore(store), [onStore, store]);
  return null;
}

async function seedPersistedState(
  storage: MemoryStorageAdapter,
  state: unknown,
  version: number = FILE_EXPLORER_STORAGE_VERSION
): Promise<void> {
  await storage.setItem(
    FILE_EXPLORER_STORAGE_KEY,
    JSON.stringify({
      state,
      version,
    })
  );
}

describe('FileExplorerProvider persistence recovery notice', () => {
  beforeEach(() => {
    showToast.mockReset();
  });

  afterEach(() => cleanup());

  it('shows one useful redacted toast when corrupt persisted state is discarded', async () => {
    const sensitivePath = '/Users/alice/secret-client/source.ts';
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      filePath: sensitivePath,
      folderStates: 'corrupt',
    });
    const captured: { store?: ExplorerStore } = {};
    const captureStore = (store: ExplorerStore) => {
      captured.store = store;
    };

    const view = render(
      <FileExplorerProvider storageAdapter={storage}>
        <StoreCapture onStore={captureStore} />
      </FileExplorerProvider>
    );

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast).toHaveBeenCalledWith({
      description:
        'Saved explorer settings could not be restored and were reset. Your files were not changed.',
      title: 'Explorer settings reset',
    });
    expect(JSON.stringify(showToast.mock.calls)).not.toContain(sensitivePath);
    expect(captured.store?.getState().persistenceRecoveryNotice).toBeNull();

    view.rerender(
      <FileExplorerProvider storageAdapter={storage}>
        <StoreCapture onStore={captureStore} />
      </FileExplorerProvider>
    );
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('shows the same redacted toast when an unsupported persisted version is discarded', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(
      storage,
      {
        ...validSerializedState,
        currentFolderId: '/Users/alice/future-client-project',
      },
      FILE_EXPLORER_STORAGE_VERSION + 1
    );

    render(
      <FileExplorerProvider storageAdapter={storage}>
        <div />
      </FileExplorerProvider>
    );

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(showToast.mock.calls)).not.toContain('future-client-project');
  });

  it('truthfully reports an unavailable persisted-state read', async () => {
    const backingStorage = new MemoryStorageAdapter();
    await seedPersistedState(backingStorage, validSerializedState);
    let remainingReadFailures = 2;
    const unavailableStorage = {
      clear: () => backingStorage.clear(),
      getAllKeys: () => backingStorage.getAllKeys(),
      getItem: async (key: string) => {
        if (remainingReadFailures > 0) {
          remainingReadFailures -= 1;
          throw new Error('Storage temporarily unavailable');
        }
        return await backingStorage.getItem(key);
      },
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => backingStorage.setItem(key, value),
    };

    render(
      <FileExplorerProvider storageAdapter={unavailableStorage}>
        <div />
      </FileExplorerProvider>
    );

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast).toHaveBeenCalledWith({
      description:
        'Saved explorer settings could not be read. Changes will be saved when storage becomes available. Your files were not changed.',
      title: 'Explorer settings unavailable',
    });
  });

  it.each([
    ['absent first-run state', null],
    ['valid persisted state', validSerializedState],
  ])('does not notify for %s', async (_caseName, persistedState) => {
    const storage = new MemoryStorageAdapter();
    if (persistedState) {
      await seedPersistedState(storage, persistedState);
    }
    const captured: { store?: ExplorerStore } = {};

    render(
      <FileExplorerProvider storageAdapter={storage}>
        <StoreCapture
          onStore={(store) => {
            captured.store = store;
          }}
        />
      </FileExplorerProvider>
    );

    await waitFor(() =>
      expect(
        (captured.store as PersistCapableExplorerStore | undefined)?.persist.hasHydrated()
      ).toBe(true)
    );
    await Promise.resolve();
    expect(showToast).not.toHaveBeenCalled();
  });
});
