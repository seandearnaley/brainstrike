import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
} from '@brainstrike/file-explorer-ui/shell';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useSearchSelectionBridge } from '../use-search-selection-bridge';

const ROOT = 'root-1';
const OTHER_ROOT = 'root-2';
const PATH = 'src/a.ts';
const KEY = encodeFileSelection(ROOT, PATH);

function createWrapper() {
  const storageAdapter = new MemoryStorageAdapter();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <FileExplorerProvider storageAdapter={storageAdapter}>{children}</FileExplorerProvider>;
  };
}

function renderBridge() {
  return renderHook(
    () => ({
      bridge: useSearchSelectionBridge(),
      store: useFileExplorerStoreContext(),
    }),
    { wrapper: createWrapper() }
  );
}

describe('useSearchSelectionBridge', () => {
  it('toggleFile(true) selects the explorer file; toggleFile(false) deselects it', () => {
    const { result } = renderBridge();

    act(() => result.current.bridge.toggleFile(KEY, true));
    expect(result.current.bridge.fileState(KEY)).toBe('checked');
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(true);

    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(result.current.bridge.fileState(KEY)).toBe('unchecked');
    expect(result.current.store.getState().selectedFilePaths.has(KEY)).toBe(false);
  });

  it('is idempotent: toggling to the current state changes nothing', () => {
    const { result } = renderBridge();
    act(() => result.current.bridge.toggleFile(KEY, true));
    const before = result.current.store.getState().selectedFilePaths;
    act(() => result.current.bridge.toggleFile(KEY, true));
    expect(result.current.store.getState().selectedFilePaths).toBe(before);
  });

  it('reads and writes a FOREIGN (non-focused) root via its folderState, like the explorer tree', () => {
    const { result } = renderBridge();

    act(() => {
      result.current.store.setState({ currentFolderId: OTHER_ROOT });
    });

    act(() => result.current.bridge.toggleFile(KEY, true));

    const state = result.current.store.getState();
    expect(state.selectedFilePaths.has(KEY)).toBe(false);
    expect(state.folderStates[ROOT]?.selectedFilePaths.has(KEY)).toBe(true);
    expect(result.current.bridge.fileState(KEY)).toBe('checked');

    act(() => result.current.bridge.toggleFile(KEY, false));
    expect(result.current.store.getState().folderStates[ROOT]?.selectedFilePaths.has(KEY)).toBe(
      false
    );
    expect(result.current.bridge.fileState(KEY)).toBe('unchecked');
  });
});
