import * as fileExplorer from '@brainstrike/file-explorer';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../file-explorer-provider';

// Utility wrapper for provider
function wrapper(storage: MemoryStorageAdapter) {
  const store = fileExplorer.createFileExplorerStore(storage);
  return ({ children }: { children: ReactNode }) => (
    <FileExplorerProvider store={store}>{children}</FileExplorerProvider>
  );
}

describe('FileExplorerProvider', () => {
  it('throws when useFileExplorerStoreContext is used outside the provider', () => {
    expect(() => {
      renderHook(() => useFileExplorerStoreContext());
    }).toThrow('useFileExplorerStoreContext must be used within a FileExplorerProvider');
  });

  it('provides store instance from props', () => {
    const storage = new MemoryStorageAdapter();
    const store = fileExplorer.createFileExplorerStore(storage);

    const { result } = renderHook(() => useFileExplorerStoreContext(), {
      wrapper: ({ children }) => (
        <FileExplorerProvider store={store}>{children}</FileExplorerProvider>
      ),
    });

    expect(result.current).toBe(store);
  });
});
