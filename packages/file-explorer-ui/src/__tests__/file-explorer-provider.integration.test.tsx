/**
 * @vitest-environment happy-dom
 */
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { flushAllTimersAndMicrotasks } from '@brainstrike/test-utils';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useFileSystemInstance as useFileSystem } from '../shell/use-file-system-context';

interface ExposedHooks {
  fs: ReturnType<typeof useFileSystem>;
  store: ReturnType<typeof useFileExplorerStoreContext>;
}

function HookExposer({ onReady }: { onReady: (hooks: ExposedHooks) => void }) {
  const store = useFileExplorerStoreContext();
  const fs = useFileSystem();
  useEffect(() => {
    onReady({ store, fs });
  }, [onReady, store, fs]);
  return null;
}

describe('FileExplorerProvider integration', () => {
  it('persists state between provider instances', async () => {
    // v5: currentFolderId is a durable RootId UUID (not handle.path). Mock randomUUID
    // so we get a predictable UUID to build selection keys and cross-check persistence.
    const MOCK_ROOT_ID = 'cccccccc-dddd-eeee-ffff-000000000001';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      MOCK_ROOT_ID as ReturnType<typeof crypto.randomUUID>
    );

    const storage = new MemoryStorageAdapter();
    const fsAdapter = new MockFileSystemAdapter(MockFileSystemAdapter.createSimpleFileSystem());

    let exposure: ExposedHooks | null = null;

    const { unmount } = render(
      <AdaptersProvider fileSystemAdapter={fsAdapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>
          <HookExposer
            onReady={(h) => {
              exposure = h;
            }}
          />
        </FileExplorerProvider>
      </AdaptersProvider>
    );

    await waitFor(() => expect(exposure).not.toBeNull());
    if (!exposure) {
      throw new Error('exposure not ready');
    }

    const { store, fs } = exposure as unknown as ExposedHooks;
    let handle = null as Awaited<ReturnType<typeof fs.selectRootDirectory>> | null;
    await act(async () => {
      handle = await fs.selectRootDirectory();
    });
    expect(handle).not.toBeNull();
    if (!handle) {
      return;
    }
    expect(handle.name).toBe('mock-root');
    const folderId = store.getState().currentFolderId;
    // v5: currentFolderId is the durable RootId UUID assigned on selectRootDirectory.
    expect(folderId).toBe(MOCK_ROOT_ID);

    const filePath = `${handle.path}/README.md`;
    act(() => {
      store.getState().toggleSelectedFile(folderId as string, filePath);
    });

    // Deterministically flush debounced/persisted state
    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    await flushAllTimersAndMicrotasks();
    vi.useRealTimers();

    // v5: selection key uses the RootId UUID, not the path.
    const key = encodeFileSelection(MOCK_ROOT_ID, filePath);
    expect(store.getState().selectedFilePaths.has(key)).toBe(true);

    unmount();

    let exposure2: ExposedHooks | null = null;

    render(
      <AdaptersProvider fileSystemAdapter={fsAdapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>
          <HookExposer
            onReady={(h) => {
              exposure2 = h;
            }}
          />
        </FileExplorerProvider>
      </AdaptersProvider>
    );

    await waitFor(() => expect(exposure2).not.toBeNull());
    if (!exposure2) {
      throw new Error('exposure2 not ready');
    }

    const { store: store2 } = exposure2 as unknown as ExposedHooks;
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(200);
      await flushAllTimersAndMicrotasks();
    });
    vi.useRealTimers();

    // v5: persisted currentFolderId is the RootId UUID.
    expect(store2.getState().currentFolderId).toBe(MOCK_ROOT_ID);
    expect(store2.getState().selectedFilePaths.has(key)).toBe(true);

    vi.restoreAllMocks();
  });
});
