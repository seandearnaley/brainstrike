import * as fileExplorer from '@brainstrike/file-explorer';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
  useOptionalFileExplorerStoreSelector,
} from '../shell/file-explorer-provider';

const wrapper = ({ children }: { children: ReactNode }) => (
  <FileExplorerProvider>{children}</FileExplorerProvider>
);

describe('FileExplorerProvider', () => {
  it('throws when useFileExplorerStoreContext is used outside the provider', () => {
    expect(() => {
      renderHook(() => useFileExplorerStoreContext());
    }).toThrow('useFileExplorerStoreContext must be used within a FileExplorerProvider');
  });

  it('provides the store it creates', () => {
    // Create a dummy store using the real factory so it matches expected type
    const dummyStore = fileExplorer.createFileExplorerStore();
    const spy = vi.spyOn(fileExplorer, 'createFileExplorerStore').mockReturnValue(dummyStore);

    const { result } = renderHook(() => useFileExplorerStoreContext(), {
      wrapper,
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(result.current).toBe(dummyStore);

    spy.mockRestore();
  });

  it('selects live store state inside the provider', () => {
    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        const currentFolderId = useFileExplorerStoreSelector((state) => state.currentFolderId);
        return { currentFolderId, store };
      },
      { wrapper }
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
      { wrapper }
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
});
