import * as fileExplorer from '@brainstrike/file-explorer';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../file-explorer-provider';

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
});
