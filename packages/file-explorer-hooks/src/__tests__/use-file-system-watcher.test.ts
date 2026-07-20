import type {
  DirectoryHandle,
  FileSystemAdapter,
  FileSystemWatchSignal,
} from '@brainstrike/file-system';
import type { FileSystemChange } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileSystemWatcher } from '../use-file-system-watcher';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandle(rootId: string): DirectoryHandle {
  return {
    kind: 'directory' as const,
    name: rootId,
    path: `/roots/${rootId}`,
    platform: 'web' as const,
  };
}

type WatchCallback = (changes: FileSystemChange[]) => void;
type OnChanges = (rootId: string, changes: FileSystemChange[]) => void;
type OnSignal = (rootId: string, signal: FileSystemWatchSignal) => void;

interface WatchCall {
  callback: WatchCallback;
  disposer: () => void;
  handle: DirectoryHandle;
  onSignal: ((signal: FileSystemWatchSignal) => void) | undefined;
}

function makeAdapter(supportsWatch = true): FileSystemAdapter & {
  watchCalls: WatchCall[];
} {
  const watchCalls: WatchCall[] = [];

  const baseAdapter = {
    exists: vi.fn(),
    isFileSystemAccessSupported: vi.fn(),
    readDirectory: vi.fn(),
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
    requestPermission: vi.fn(),
    resolveFileForIndexing: vi.fn(),
    restoreLastFolder: vi.fn(),
    watchCalls,
  } as unknown as FileSystemAdapter & { watchCalls: WatchCall[] };

  if (supportsWatch) {
    const adapter = baseAdapter as unknown as {
      watchDirectory: FileSystemAdapter['watchDirectory'];
    };
    adapter['watchDirectory'] = (
      handle: DirectoryHandle,
      callback: WatchCallback,
      onSignal?: (signal: FileSystemWatchSignal) => void
    ): (() => void) => {
      const disposer = vi.fn<() => void>();
      watchCalls.push({ callback, disposer, handle, onSignal });
      return disposer;
    };
  }

  return baseAdapter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useFileSystemWatcher', () => {
  let onChanges: OnChanges;

  beforeEach(() => {
    onChanges = vi.fn<OnChanges>();
  });

  it('starts one watcher per root on mount', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');
    const handleB = makeHandle('root-b');

    renderHook(() =>
      useFileSystemWatcher({
        adapter,
        onChanges,
        roots: [
          { handle: handleA, rootId: 'root-a' },
          { handle: handleB, rootId: 'root-b' },
        ],
      })
    );

    expect(adapter.watchCalls).toHaveLength(2);
    expect(adapter.watchCalls[0]!.handle).toBe(handleA);
    expect(adapter.watchCalls[1]!.handle).toBe(handleB);
  });

  it('when a root is added, starts a new watcher without restarting existing ones', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');
    const handleB = makeHandle('root-b');

    const { rerender } = renderHook(
      ({ roots }: { roots: { rootId: string; handle: DirectoryHandle }[] }) =>
        useFileSystemWatcher({ adapter, onChanges, roots }),
      { initialProps: { roots: [{ handle: handleA, rootId: 'root-a' }] } }
    );

    expect(adapter.watchCalls).toHaveLength(1);
    const firstDisposer = adapter.watchCalls[0]!.disposer;

    rerender({
      roots: [
        { handle: handleA, rootId: 'root-a' },
        { handle: handleB, rootId: 'root-b' },
      ],
    });

    // root-a disposer must NOT have been called (existing watcher stays alive)
    expect(firstDisposer).not.toHaveBeenCalled();
    // A second watcher should have been started for root-b
    expect(adapter.watchCalls).toHaveLength(2);
    expect(adapter.watchCalls[1]!.handle).toBe(handleB);
  });

  it('when a root is removed, disposes only that watcher', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');
    const handleB = makeHandle('root-b');

    const { rerender } = renderHook(
      ({ roots }: { roots: { rootId: string; handle: DirectoryHandle }[] }) =>
        useFileSystemWatcher({ adapter, onChanges, roots }),
      {
        initialProps: {
          roots: [
            { handle: handleA, rootId: 'root-a' },
            { handle: handleB, rootId: 'root-b' },
          ],
        },
      }
    );

    expect(adapter.watchCalls).toHaveLength(2);
    const disposerA = adapter.watchCalls.find((c) => c.handle === handleA)!.disposer;
    const disposerB = adapter.watchCalls.find((c) => c.handle === handleB)!.disposer;

    // Remove root-b
    rerender({ roots: [{ handle: handleA, rootId: 'root-a' }] });

    expect(disposerB).toHaveBeenCalledOnce();
    expect(disposerA).not.toHaveBeenCalled();
  });

  // Disconnect flow (Phase 5): removeRootDirectory shrinks rootDirectoryHandles,
  // which shrinks the derived watcherRoots array — the Map diff alone must tear
  // down the removed root's watcher without restarting the survivors.
  it('tears down the removed root watcher when the roots array shrinks (disconnect)', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');
    const handleB = makeHandle('root-b');
    const handleC = makeHandle('root-c');

    const { rerender } = renderHook(
      ({ roots }: { roots: { rootId: string; handle: DirectoryHandle }[] }) =>
        useFileSystemWatcher({ adapter, onChanges, roots }),
      {
        initialProps: {
          roots: [
            { handle: handleA, rootId: 'root-a' },
            { handle: handleB, rootId: 'root-b' },
            { handle: handleC, rootId: 'root-c' },
          ],
        },
      }
    );

    expect(adapter.watchCalls).toHaveLength(3);
    const disposerA = adapter.watchCalls.find((c) => c.handle === handleA)!.disposer;
    const disposerB = adapter.watchCalls.find((c) => c.handle === handleB)!.disposer;
    const disposerC = adapter.watchCalls.find((c) => c.handle === handleC)!.disposer;

    // Disconnect root-b: the handles array shrinks from 3 → 2.
    rerender({
      roots: [
        { handle: handleA, rootId: 'root-a' },
        { handle: handleC, rootId: 'root-c' },
      ],
    });

    expect(disposerB).toHaveBeenCalledOnce();
    expect(disposerA).not.toHaveBeenCalled();
    expect(disposerC).not.toHaveBeenCalled();
    // No watcher was restarted for the surviving roots.
    expect(adapter.watchCalls).toHaveLength(3);
  });

  it('disposes all watchers on unmount', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');
    const handleB = makeHandle('root-b');

    const { unmount } = renderHook(() =>
      useFileSystemWatcher({
        adapter,
        onChanges,
        roots: [
          { handle: handleA, rootId: 'root-a' },
          { handle: handleB, rootId: 'root-b' },
        ],
      })
    );

    const disposers = adapter.watchCalls.map((c) => c.disposer);
    expect(disposers).toHaveLength(2);

    act(() => {
      unmount();
    });

    for (const disposer of disposers) {
      expect(disposer).toHaveBeenCalledOnce();
    }
  });

  it('forwards nested changes to onChanges with the correct rootId and unchanged paths', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');

    renderHook(() =>
      useFileSystemWatcher({
        adapter,
        onChanges,
        roots: [{ handle: handleA, rootId: 'root-a' }],
      })
    );

    expect(adapter.watchCalls).toHaveLength(1);
    const watchCall = adapter.watchCalls[0]!;
    const changes: FileSystemChange[] = [
      { kind: 'file', path: '/roots/root-a/src/new.ts', type: 'added' },
      { kind: 'file', path: '/roots/root-a/src/nested/update.ts', type: 'modified' },
      { kind: 'file', path: '/roots/root-a/src/nested/remove.ts', type: 'removed' },
    ];

    act(() => {
      watchCall.callback(changes);
    });

    expect(onChanges).toHaveBeenCalledOnce();
    expect(onChanges).toHaveBeenCalledWith('root-a', changes);
  });

  it('does not start watchers when adapter has no watchDirectory method', () => {
    const adapter = makeAdapter(false); // no watchDirectory
    const handleA = makeHandle('root-a');

    // Should not throw
    expect(() =>
      renderHook(() =>
        useFileSystemWatcher({
          adapter,
          onChanges,
          roots: [{ handle: handleA, rootId: 'root-a' }],
        })
      )
    ).not.toThrow();

    expect(onChanges).not.toHaveBeenCalled();
  });

  it('no-ops gracefully with an empty roots array', () => {
    const adapter = makeAdapter();

    expect(() =>
      renderHook(() => useFileSystemWatcher({ adapter, onChanges, roots: [] }))
    ).not.toThrow();

    expect(adapter.watchCalls).toHaveLength(0);
  });

  it('changing onChanges identity does NOT restart existing watchers', () => {
    // This tests the stable-ref pattern: onChangesRef.current is updated on
    // every render, so the diff effect intentionally excludes onChanges from
    // its dep array. A new callback object must not cause any watcher to restart.
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');

    const onChangesV1 = vi.fn<OnChanges>();
    const onChangesV2 = vi.fn<OnChanges>();

    const roots = [{ handle: handleA, rootId: 'root-a' }];
    const { rerender } = renderHook(
      ({ cb }: { cb: OnChanges }) => useFileSystemWatcher({ adapter, onChanges: cb, roots }),
      { initialProps: { cb: onChangesV1 } }
    );

    expect(adapter.watchCalls).toHaveLength(1);
    const originalDisposer = adapter.watchCalls[0]!.disposer;

    // Swap callback identity — roots and adapter are UNCHANGED
    rerender({ cb: onChangesV2 });

    // Watcher must NOT have been disposed (no restart)
    expect(originalDisposer).not.toHaveBeenCalled();
    // Still exactly one watch call total (no new subscription started)
    expect(adapter.watchCalls).toHaveLength(1);

    // The latest callback should still be invoked for new changes
    const changes: FileSystemChange[] = [
      { kind: 'file', path: '/roots/root-a/updated.ts', type: 'modified' },
    ];
    act(() => {
      adapter.watchCalls[0]!.callback(changes);
    });

    expect(onChangesV1).not.toHaveBeenCalled();
    expect(onChangesV2).toHaveBeenCalledWith('root-a', changes);
  });

  it('forwards watcher health signals to onSignal with the correct rootId', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');
    const handleB = makeHandle('root-b');
    const onSignal = vi.fn<OnSignal>();

    renderHook(() =>
      useFileSystemWatcher({
        adapter,
        onChanges,
        onSignal,
        roots: [
          { handle: handleA, rootId: 'root-a' },
          { handle: handleB, rootId: 'root-b' },
        ],
      })
    );

    act(() => {
      adapter.watchCalls[0]!.onSignal?.({ type: 'overflow' });
      adapter.watchCalls[1]!.onSignal?.({ message: 'observation invalid', type: 'errored' });
    });

    expect(onSignal).toHaveBeenCalledTimes(2);
    expect(onSignal).toHaveBeenNthCalledWith(1, 'root-a', { type: 'overflow' });
    expect(onSignal).toHaveBeenNthCalledWith(2, 'root-b', {
      message: 'observation invalid',
      type: 'errored',
    });
    // An errored signal does NOT restart the watch — no silent retry loop.
    expect(adapter.watchCalls).toHaveLength(2);
  });

  it('uses the latest onSignal identity without restarting watchers', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');
    const onSignalV1 = vi.fn<OnSignal>();
    const onSignalV2 = vi.fn<OnSignal>();

    const roots = [{ handle: handleA, rootId: 'root-a' }];
    const { rerender } = renderHook(
      ({ sig }: { sig: OnSignal }) =>
        useFileSystemWatcher({ adapter, onChanges, onSignal: sig, roots }),
      { initialProps: { sig: onSignalV1 } }
    );

    rerender({ sig: onSignalV2 });
    expect(adapter.watchCalls).toHaveLength(1);

    act(() => {
      adapter.watchCalls[0]!.onSignal?.({ type: 'overflow' });
    });

    expect(onSignalV1).not.toHaveBeenCalled();
    expect(onSignalV2).toHaveBeenCalledWith('root-a', { type: 'overflow' });
  });
});
