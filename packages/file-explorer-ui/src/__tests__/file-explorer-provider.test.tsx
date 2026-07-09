import * as fileExplorer from '@brainstrike/file-explorer';
import { clearPersistentUiStateWithResult } from '@brainstrike/preferences/settings/system/factory-reset-helpers';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
  useOptionalFileExplorerStoreSelector,
} from '../shell/file-explorer-provider';

// Utility wrapper for provider
function wrapper(storage: MemoryStorageAdapter) {
  return ({ children }: { children: ReactNode }) => (
    <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
  );
}

describe('FileExplorerProvider', () => {
  it('throws when useFileExplorerStoreContext is used outside the provider', () => {
    expect(() => {
      renderHook(() => useFileExplorerStoreContext());
    }).toThrow('useFileExplorerStoreContext must be used within a FileExplorerProvider');
  });

  it('provides store instance with the supplied storage adapter', () => {
    const storage = new MemoryStorageAdapter();

    // Create a dummy store using the real factory so it matches expected type
    const dummyStore = fileExplorer.createFileExplorerStore(new MemoryStorageAdapter());
    const spy = vi.spyOn(fileExplorer, 'createFileExplorerStore').mockReturnValue(dummyStore);

    const { result } = renderHook(() => useFileExplorerStoreContext(), {
      wrapper: wrapper(storage),
    });

    expect(spy).toHaveBeenCalledWith(storage);
    expect(result.current).toBe(dummyStore);

    spy.mockRestore();
  });

  it('selects live store state inside the provider', () => {
    const storage = new MemoryStorageAdapter();

    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        const currentFolderId = useFileExplorerStoreSelector((state) => state.currentFolderId);
        return { currentFolderId, store };
      },
      { wrapper: wrapper(storage) }
    );

    expect(result.current.currentFolderId).toBeNull();

    act(() => {
      result.current.store.setState({
        currentFolderId: 'folder-1',
      } as Partial<ReturnType<typeof result.current.store.getState>>);
    });

    expect(result.current.currentFolderId).toBe('folder-1');
  });

  it('returns the fallback selector value outside the provider', () => {
    const { result, rerender } = renderHook(
      ({ fallbackValue }: { fallbackValue: string }) =>
        useOptionalFileExplorerStoreSelector(() => 'live-value', fallbackValue),
      {
        initialProps: { fallbackValue: 'fallback-a' },
      }
    );

    expect(result.current).toBe('fallback-a');

    rerender({ fallbackValue: 'fallback-b' });
    expect(result.current).toBe('fallback-b');
  });

  it('reuses the previous selection when the equality function reports no change', () => {
    const storage = new MemoryStorageAdapter();

    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        const selection = useOptionalFileExplorerStoreSelector(
          (state) => ({ currentFolderId: state.currentFolderId }),
          { currentFolderId: 'fallback' },
          (left, right) => left.currentFolderId === right.currentFolderId
        );
        return { selection, store };
      },
      { wrapper: wrapper(storage) }
    );

    const initialSelection = result.current.selection;
    expect(initialSelection.currentFolderId).toBeNull();

    act(() => {
      result.current.store.setState({
        expandedDirectoryPaths: new Set(['folder-1']),
      } as Partial<ReturnType<typeof result.current.store.getState>>);
    });

    expect(result.current.selection).toBe(initialSelection);
  });

  it('clears live file selections when factory reset drains session stores', async () => {
    // Search bridge selects containing files alongside chunks. Clearing only
    // the chunk store would leave whole-file selections after reset.
    const storage = new MemoryStorageAdapter();
    const { result } = renderHook(() => useFileExplorerStoreContext(), {
      wrapper: wrapper(storage),
    });

    act(() => {
      result.current.getState().setFolderSelection('root-a', ['root-a|@|src/a.ts']);
      result.current.getState().setSelectedFiles(new Set(['root-a|@|src/a.ts']));
    });
    expect(result.current.getState().selectedFilePaths.size).toBe(1);
    expect(result.current.getState().folderStates['root-a']?.selectedFilePaths.size).toBe(1);

    const resetResult = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    expect(resetResult.success).toBe(true);
    expect(result.current.getState().selectedFilePaths.size).toBe(0);
    expect(result.current.getState().folderStates['root-a']?.selectedFilePaths.size).toBe(0);
  });
});
