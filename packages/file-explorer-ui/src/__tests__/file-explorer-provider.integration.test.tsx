import { createFileExplorerStore } from '@brainstrike/file-explorer';
/**
 * @vitest-environment happy-dom
 */
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { encodeFileSelection } from '@brainstrike/utils';
import { render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../file-explorer-provider';
import { useFileSystem } from '../use-file-system-context';

interface ExposedHooks {
  store: ReturnType<typeof useFileExplorerStoreContext>;
  fs: ReturnType<typeof useFileSystem>;
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
    const storage = new MemoryStorageAdapter();
    const fsAdapter = new MockFileSystemAdapter(MockFileSystemAdapter.createSimpleFileSystem());
    const initialStore = createFileExplorerStore(storage);

    let exposure: ExposedHooks | null = null;

    const { unmount } = render(
      <AdaptersProvider
        fileSystemAdapter={fsAdapter}
        storageAdapter={storage}
        fileExplorerStore={initialStore}
      >
        <FileExplorerProvider store={initialStore}>
          <HookExposer
            onReady={(h) => {
              exposure = h;
            }}
          />
        </FileExplorerProvider>
      </AdaptersProvider>
    );

    await waitFor(() => expect(exposure).not.toBeNull());
    if (!exposure) throw new Error('exposure not ready');

    const { store: exposedStore, fs } = exposure as unknown as ExposedHooks;
    const handle = await fs.selectRootDirectory();
    expect(handle).not.toBeNull();
    if (!handle) return;
    expect(handle.name).toBe('mock-root');
    const folderId = exposedStore.getState().currentFolderId;
    expect(folderId).toBe('mock-root');

    const filePath = `${handle.path}/README.md`;
    exposedStore.getState().toggleSelectedFile(folderId as string, filePath);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const key = encodeFileSelection('mock-root', filePath);
    expect(exposedStore.getState().selectedFilePaths.has(key)).toBe(true);

    unmount();

    let exposure2: ExposedHooks | null = null;

    render(
      <AdaptersProvider
        fileSystemAdapter={fsAdapter}
        storageAdapter={storage}
        fileExplorerStore={initialStore}
      >
        <FileExplorerProvider store={initialStore}>
          <HookExposer
            onReady={(h) => {
              exposure2 = h;
            }}
          />
        </FileExplorerProvider>
      </AdaptersProvider>
    );

    await waitFor(() => expect(exposure2).not.toBeNull());
    if (!exposure2) throw new Error('exposure2 not ready');

    const { store: store2 } = exposure2 as unknown as ExposedHooks;
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(store2.getState().currentFolderId).toBe('mock-root');
    expect(store2.getState().selectedFilePaths.has(key)).toBe(true);
  });
});
