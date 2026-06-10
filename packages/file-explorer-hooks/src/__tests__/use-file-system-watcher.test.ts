import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
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

interface WatchCall {
  callback: WatchCallback;
  disposer: () => void;
  handle: DirectoryHandle;
}

function makeAdapter(supportsWatch = true): FileSystemAdapter & {
  watchCalls: WatchCall[];
} {
  const watchCalls: WatchCall[] = [];

  const baseAdapter = {
    watchCalls,
    requestDirectoryAccess: vi.fn(),
    readDirectory: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn(),
    isFileSystemAccessSupported: vi.fn(),
    restoreLastFolder: vi.fn(),
    requestPermission: vi.fn(),
    resolveFileForIndexing: vi.fn(),
  } as unknown as FileSystemAdapter & { watchCalls: WatchCall[] };

  if (supportsWatch) {
    const adapter = baseAdapter as unknown as {
      watchDirectory: FileSystemAdapter['watchDirectory'];
    };
    adapter['watchDirectory'] = (
      handle: DirectoryHandle,
      callback: WatchCallback
    ): (() => void) => {
      const disposer = vi.fn<() => void>();
      watchCalls.push({ handle, callback, disposer });
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
        roots: [
          { rootId: 'root-a', handle: handleA },
          { rootId: 'root-b', handle: handleB },
        ],
        onChanges,
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
        useFileSystemWatcher({ adapter, roots, onChanges }),
      { initialProps: { roots: [{ rootId: 'root-a', handle: handleA }] } }
    );

    expect(adapter.watchCalls).toHaveLength(1);
    const firstDisposer = adapter.watchCalls[0]!.disposer;

    rerender({
      roots: [
        { rootId: 'root-a', handle: handleA },
        { rootId: 'root-b', handle: handleB },
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
        useFileSystemWatcher({ adapter, roots, onChanges }),
      {
        initialProps: {
          roots: [
            { rootId: 'root-a', handle: handleA },
            { rootId: 'root-b', handle: handleB },
          ],
        },
      }
    );

    expect(adapter.watchCalls).toHaveLength(2);
    const disposerA = adapter.watchCalls.find((c) => c.handle === handleA)!.disposer;
    const disposerB = adapter.watchCalls.find((c) => c.handle === handleB)!.disposer;

    // Remove root-b
    rerender({ roots: [{ rootId: 'root-a', handle: handleA }] });

    expect(disposerB).toHaveBeenCalledOnce();
    expect(disposerA).not.toHaveBeenCalled();
  });

  it('disposes all watchers on unmount', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');
    const handleB = makeHandle('root-b');

    const { unmount } = renderHook(() =>
      useFileSystemWatcher({
        adapter,
        roots: [
          { rootId: 'root-a', handle: handleA },
          { rootId: 'root-b', handle: handleB },
        ],
        onChanges,
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

  it('forwards changes to onChanges with the correct rootId', () => {
    const adapter = makeAdapter();
    const handleA = makeHandle('root-a');

    renderHook(() =>
      useFileSystemWatcher({
        adapter,
        roots: [{ rootId: 'root-a', handle: handleA }],
        onChanges,
      })
    );

    expect(adapter.watchCalls).toHaveLength(1);
    const watchCall = adapter.watchCalls[0]!;
    const changes: FileSystemChange[] = [
      { kind: 'file', path: '/roots/root-a/foo.ts', type: 'modified' },
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
          roots: [{ rootId: 'root-a', handle: handleA }],
          onChanges,
        })
      )
    ).not.toThrow();

    expect(onChanges).not.toHaveBeenCalled();
  });

  it('no-ops gracefully with an empty roots array', () => {
    const adapter = makeAdapter();

    expect(() =>
      renderHook(() => useFileSystemWatcher({ adapter, roots: [], onChanges }))
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

    const roots = [{ rootId: 'root-a', handle: handleA }];
    const { rerender } = renderHook(
      ({ cb }: { cb: OnChanges }) => useFileSystemWatcher({ adapter, roots, onChanges: cb }),
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
});
