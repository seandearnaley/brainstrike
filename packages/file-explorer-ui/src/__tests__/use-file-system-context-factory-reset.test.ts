import {
  clearPersistentUiStateWithResult,
  prepareFactoryReset,
} from '@brainstrike/app-state/factory-reset';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFileSystemInstance as useFileSystem } from '../shell/use-file-system-context';
import { FileExplorerTestWrapper } from './test-helpers';

// Its own file: reset preparation is terminal for the renderer, so the
// app-state flag it sets never clears within one module graph.
describe('useFileSystem — factory reset preparation (BST-2149)', () => {
  it('the explorer the reset remounts starts no root watch', async () => {
    const handle = {
      kind: 'directory',
      name: 'reset-root',
      path: '/reset-root',
      platform: 'electron',
      rootId: 'reset-root-id',
    } as DirectoryHandle;
    const disposeWatch = vi.fn();
    const adapter = Object.assign(new MockFileSystemAdapter(), {
      restoreLastFolder: vi.fn(async () => handle),
      watchDirectory: vi.fn(() => disposeWatch),
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FileExplorerTestWrapper, { children, mockFileSystemAdapter: adapter });

    const { result } = renderHook(() => useFileSystem(), { wrapper });
    await waitFor(() => expect(result.current.rootDirectoryHandle?.path).toBe('/reset-root'));
    expect(adapter.watchDirectory).toHaveBeenCalledTimes(1);
    const restoresBeforeReset = adapter.restoreLastFolder.mock.calls.length;

    // The desktop reset prepares the renderer, then clears its live stores,
    // which remounts the explorer subtree while Main retires the folders.
    await act(async () => {
      await prepareFactoryReset();
      await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    });
    await waitFor(() =>
      expect(adapter.restoreLastFolder.mock.calls.length).toBeGreaterThan(restoresBeforeReset)
    );
    await waitFor(() => expect(result.current.rootDirectoryHandle?.path).toBe('/reset-root'));

    expect(disposeWatch).toHaveBeenCalledTimes(1);
    expect(adapter.watchDirectory).toHaveBeenCalledTimes(1);
  });
});
