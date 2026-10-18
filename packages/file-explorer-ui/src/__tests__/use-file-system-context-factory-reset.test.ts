import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let factoryReset: typeof import('@brainstrike/app-state/factory-reset');
let useFileSystem: typeof import('../shell/use-file-system-context').useFileSystemInstance;
let useFactoryResetWatchFence: typeof import('../shell/use-factory-reset-watch-fence').useFactoryResetWatchFence;
let FileExplorerTestWrapper: typeof import('./test-helpers').FileExplorerTestWrapper;

const handle = {
  kind: 'directory',
  name: 'reset-root',
  path: '/reset-root',
  platform: 'electron',
  rootId: 'reset-root-id',
} as DirectoryHandle;

function renderExplorer(restoreLastFolder: () => Promise<DirectoryHandle | null>) {
  const disposeWatch = vi.fn();
  const adapter = Object.assign(new MockFileSystemAdapter(), {
    restoreLastFolder: vi.fn(restoreLastFolder),
    watchDirectory: vi.fn(() => disposeWatch),
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(FileExplorerTestWrapper, { children, mockFileSystemAdapter: adapter });
  const { result } = renderHook(() => useFileSystem(), { wrapper });
  return { adapter, disposeWatch, result };
}

describe('useFileSystem — factory reset preparation (BST-2149)', () => {
  beforeEach(async () => {
    // Reset preparation is terminal for a renderer. Each test owns a fresh module lifetime.
    vi.resetModules();
    factoryReset = await import('@brainstrike/app-state/factory-reset');
    ({ useFileSystemInstance: useFileSystem } = await import('../shell/use-file-system-context'));
    ({ useFactoryResetWatchFence } = await import('../shell/use-factory-reset-watch-fence'));
    ({ FileExplorerTestWrapper } = await import('./test-helpers'));
  });

  it('the fence admits no watch once preparation began, whenever it is requested', async () => {
    const adapter = Object.assign(new MockFileSystemAdapter(), {
      watchDirectory: vi.fn(() => vi.fn()),
    });
    const { result } = renderHook(() => useFactoryResetWatchFence(adapter));

    await act(async () => {
      await factoryReset.prepareFactoryReset();
    });
    // A watch effect that flushes after preparation asks the adapter directly.
    const dispose = result.current.watchDirectory?.(handle, vi.fn(), vi.fn());

    expect(adapter.watchDirectory).not.toHaveBeenCalled();
    expect(dispose).toBeTypeOf('function');
  });

  it('a watch the fence retired delivers nothing more to its owner', async () => {
    type Watch = Parameters<NonNullable<FileSystemAdapter['watchDirectory']>>;
    let delivered: { callback: Watch[1]; onSignal: Watch[2] } | undefined;
    const stopWatch = vi.fn();
    const adapter = Object.assign(new MockFileSystemAdapter(), {
      watchDirectory: vi.fn((_handle: DirectoryHandle, callback: Watch[1], onSignal: Watch[2]) => {
        delivered = { callback, onSignal };
        return stopWatch;
      }),
    });
    const { result } = renderHook(() => useFactoryResetWatchFence(adapter));
    const onChanges = vi.fn();
    const onSignal = vi.fn();
    result.current.watchDirectory?.(handle, onChanges, onSignal);

    await act(async () => {
      await factoryReset.prepareFactoryReset();
    });
    delivered?.callback([{ kind: 'file', path: 'late.ts', type: 'added' }]);
    delivered?.onSignal?.({ message: 'File watching could not start', type: 'errored' });

    expect(stopWatch).toHaveBeenCalledTimes(1);
    expect(onChanges).not.toHaveBeenCalled();
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('a restore still pending when preparation begins admits no watch once it resolves', async () => {
    const restore = Promise.withResolvers<DirectoryHandle | null>();
    const { adapter, result } = renderExplorer(() => restore.promise);
    await waitFor(() => expect(adapter.restoreLastFolder).toHaveBeenCalledTimes(1));

    await act(async () => {
      await factoryReset.prepareFactoryReset();
    });
    await act(async () => {
      restore.resolve(handle);
      await restore.promise;
    });

    await waitFor(() => expect(result.current.rootDirectoryHandle?.path).toBe('/reset-root'));
    expect(adapter.watchDirectory).not.toHaveBeenCalled();
  });

  it('preparation disposes the explorer’s active watch in the same turn', async () => {
    const { adapter, disposeWatch } = renderExplorer(async () => handle);
    await waitFor(() => expect(adapter.watchDirectory).toHaveBeenCalledTimes(1));

    let preparation: Promise<void> | undefined;
    act(() => {
      preparation = factoryReset.prepareFactoryReset();
      expect(disposeWatch).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await preparation;
    });

    expect(disposeWatch).toHaveBeenCalledTimes(1);
    expect(adapter.watchDirectory).toHaveBeenCalledTimes(1);
  });

  it('the explorer the reset remounts starts no root watch', async () => {
    const { adapter, disposeWatch, result } = renderExplorer(async () => handle);
    await waitFor(() => expect(result.current.rootDirectoryHandle?.path).toBe('/reset-root'));
    expect(adapter.watchDirectory).toHaveBeenCalledTimes(1);
    const restoresBeforeReset = adapter.restoreLastFolder.mock.calls.length;

    // The desktop reset prepares the renderer, then clears its live stores,
    // which remounts the explorer subtree while the reset retires the folders.
    await act(async () => {
      await factoryReset.prepareFactoryReset();
      await factoryReset.clearPersistentUiStateWithResult({ skipIndexedDb: true });
    });
    await waitFor(() =>
      expect(adapter.restoreLastFolder.mock.calls.length).toBeGreaterThan(restoresBeforeReset)
    );
    await waitFor(() => expect(result.current.rootDirectoryHandle?.path).toBe('/reset-root'));

    expect(disposeWatch).toHaveBeenCalledTimes(1);
    expect(adapter.watchDirectory).toHaveBeenCalledTimes(1);
  });
});
