/**
 * @vitest-environment happy-dom
 */

import {
  FILE_EXPLORER_STORAGE_KEY,
  FILE_EXPLORER_STORAGE_VERSION,
} from '@brainstrike/file-explorer';
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

function seedPersistedState(state: unknown, version: number = FILE_EXPLORER_STORAGE_VERSION): void {
  localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, JSON.stringify({ state, version }));
}

describe('FileExplorerProvider persistence recovery notice', () => {
  beforeEach(() => {
    showToast.mockReset();
    localStorage.clear();
  });

  afterEach(() => cleanup());

  it('shows one useful redacted toast when corrupt persisted state is discarded', async () => {
    const sensitivePath = '/Users/alice/secret-client/source.ts';
    seedPersistedState({
      filePath: sensitivePath,
      folderStates: 'corrupt',
    });
    const captured: { store?: ExplorerStore } = {};
    const captureStore = (store: ExplorerStore) => {
      captured.store = store;
    };

    const view = render(
      <FileExplorerProvider>
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
      <FileExplorerProvider>
        <StoreCapture onStore={captureStore} />
      </FileExplorerProvider>
    );
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('shows the same redacted toast when an unsupported persisted version is discarded', async () => {
    seedPersistedState(
      {
        ...validSerializedState,
        currentFolderId: '/Users/alice/future-client-project',
      },
      FILE_EXPLORER_STORAGE_VERSION + 1
    );

    render(
      <FileExplorerProvider>
        <div />
      </FileExplorerProvider>
    );

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(showToast.mock.calls)).not.toContain('future-client-project');
  });

  it.each([
    ['absent first-run state', null],
    ['valid persisted state', validSerializedState],
  ])('does not notify for %s', async (_caseName, persistedState) => {
    if (persistedState) {
      seedPersistedState(persistedState);
    }
    const captured: { store?: ExplorerStore } = {};

    render(
      <FileExplorerProvider>
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
