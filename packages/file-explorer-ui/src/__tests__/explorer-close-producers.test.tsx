import { createFileExplorerStore } from '@brainstrike/file-explorer';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { useExplorerScrollRestore } from '../hooks/use-explorer-scroll-restore';
import { useRecursiveFolderSelect } from '../hooks/use-recursive-folder-select';
import { useRecursiveSelectAll } from '../hooks/use-recursive-select-all';
import {
  type ExplorerCloseLifecycle,
  ExplorerCloseLifecycleContext,
  useExplorerCloseProducer,
} from '../shell/explorer-close-lifecycle';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useOptionalForestTreeActions } from '../shell/forest-tree-actions-context';
import { ForestTreeActionsProvider } from '../shell/forest-tree-actions-provider';
import { useFileTreeRefreshEvents } from '../tree/use-file-tree-refresh-events';
import { useExpandedPathRestoration } from '../use-expanded-path-restoration';

function closeRegistry() {
  const producers = new Set<() => Promise<void>>();
  const persistence = new Map<() => Promise<void>, () => void>();
  let preparing = false;
  const lifecycle: ExplorerCloseLifecycle = {
    isPreparing: () => preparing,
    registerPersistence: (prepare, begin) => {
      persistence.set(prepare, begin);
      return () => {
        persistence.delete(prepare);
      };
    },
    registerProducer: (prepare) => {
      producers.add(prepare);
      return () => {
        producers.delete(prepare);
      };
    },
  };
  return {
    async close() {
      let producerResults!: Promise<PromiseSettledResult<void>[]>;
      act(() => {
        preparing = true;
        for (const begin of persistence.values()) {
          begin();
        }
        producerResults = Promise.allSettled([...producers].map((prepare) => prepare()));
      });
      const results = await producerResults;
      results.push(
        ...(await Promise.allSettled([...persistence.keys()].map((prepare) => prepare())))
      );
      const failures = [
        ...new Set(
          results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
        ),
      ];
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Explorer close test owners failed');
      }
    },
    lifecycle,
    wrapper: ({ children }: { children: ReactNode }) => (
      <ExplorerCloseLifecycleContext.Provider value={lifecycle}>
        {children}
      </ExplorerCloseLifecycleContext.Provider>
    ),
  };
}

function directory(): IFileNode {
  return {
    depth: 0,
    handle: { kind: 'directory', name: 'src', path: '/repo/src', platform: 'electron' },
    isVisible: true,
    loadState: 'unloaded',
    name: 'src',
    path: '/repo/src',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it('joins admitted physical work even when the existing producer cancellation throws', async () => {
  const registry = closeRegistry();
  const physical = Promise.withResolvers<void>();
  const failure = new Error('original producer cancellation failure');
  const view = renderHook(
    () =>
      useExplorerCloseProducer(() => {
        throw failure;
      }),
    { wrapper: registry.wrapper }
  );
  const admitted = view.result.current.track(physical.promise);
  let settled = false;
  const closing = registry.close().then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    }
  );
  try {
    await tick();
    expect(settled).toBe(false);
  } finally {
    physical.resolve();
    await admitted;
    expect(await closing).toBe(failure);
    view.unmount();
  }
});

it('joins active refresh work and fences the trailing queue and selection reconciliation', async () => {
  const registry = closeRegistry();
  const read = Promise.withResolvers<{ status: 'completed' }>();
  const refreshTree = vi.fn(() => read.promise);
  const reconcile = vi.fn();
  const view = renderHook(
    () =>
      useFileTreeRefreshEvents({
        getNormalizedTree: () => null,
        getSelectionAncestorDirectories: () => [],
        getSelectionProjectionRevision: () => 0,
        reconcileSelectionWithDirectorySnapshots: reconcile,
        refreshDirectory: vi.fn(async () => null),
        refreshTree,
        rootId: 'root',
        rootPath: '/repo',
        skipManualFullEvents: false,
      }),
    { wrapper: registry.wrapper }
  );
  const first = view.result.current();
  await waitFor(() => expect(refreshTree).toHaveBeenCalledOnce());
  const trailing = view.result.current();
  let closed = false;
  const closing = registry.close().then(() => {
    closed = true;
  });
  try {
    await tick();
    expect(closed).toBe(false);
  } finally {
    await act(async () => {
      read.resolve({ status: 'completed' });
      await Promise.all([first, trailing, closing]);
    });
  }
  expect(refreshTree).toHaveBeenCalledOnce();
  expect(reconcile).not.toHaveBeenCalled();
  view.unmount();
});

it.each([false, true])(
  'settles initial store hydration before terminal persistence admission closes (detached=%s)',
  async (detached) => {
    const registry = closeRegistry();
    const read = Promise.withResolvers<string | null>();
    const adapter = new MemoryStorageAdapter();
    vi.spyOn(adapter, 'getItem').mockReturnValue(read.promise);
    const view = renderHook(() => useFileExplorerStoreContext(), {
      wrapper: ({ children }) => (
        <FileExplorerProvider closeLifecycle={registry.lifecycle} storageAdapter={adapter}>
          {children}
        </FileExplorerProvider>
      ),
    });
    const storagePreparation = vi.spyOn(view.result.current, 'preparePersistenceClose');
    if (detached) {
      view.unmount();
    }
    const closing = registry.close();
    try {
      await tick();
      expect(storagePreparation).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        read.resolve(null);
        await closing;
      });
    }
    expect(view.result.current.persist.hasHydrated()).toBe(true);
    // A detached owner unregisters after its final admitted operation settles;
    // an attached owner proceeds to the terminal persistence phase.
    expect(storagePreparation).toHaveBeenCalledTimes(detached ? 0 : 1);
    view.unmount();
  }
);

it('flushes an admitted scroll debounce before storage retires and does not flush again on unmount', async () => {
  const registry = closeRegistry();
  const adapter = new MemoryStorageAdapter();
  const rootRef = createRef<HTMLElement>();
  rootRef.current = document.createElement('div');
  const view = renderHook(
    () => {
      useExplorerScrollRestore(rootRef);
      return useFileExplorerStoreContext();
    },
    {
      wrapper: ({ children }) => (
        <FileExplorerProvider closeLifecycle={registry.lifecycle} storageAdapter={adapter}>
          {children}
        </FileExplorerProvider>
      ),
    }
  );
  await waitFor(() => expect(view.result.current.persist.hasHydrated()).toBe(true));
  const ack = Promise.withResolvers<void>();
  const original = adapter.setItem.bind(adapter);
  const writes = vi.spyOn(adapter, 'setItem').mockImplementation(async (name, value) => {
    await ack.promise;
    await original(name, value);
  });
  rootRef.current.scrollTop = 48;
  fireEvent.scroll(rootRef.current);
  let closed = false;
  const closing = registry.close().then(() => {
    closed = true;
  });
  try {
    await tick();
    expect(view.result.current.getState().explorerScrollTop).toBe(48);
    expect(closed).toBe(false);
  } finally {
    ack.resolve();
    await closing;
  }
  const writesAtClose = writes.mock.calls.length;
  view.unmount();
  await tick();
  expect(writes.mock.calls.length).toBe(writesAtClose);
});

it.each(['folder', 'all'] as const)(
  'joins the complete admitted %s selection after cancelling a scan that ignores abort',
  async (kind) => {
    const registry = closeRegistry();
    const read = Promise.withResolvers<IFileNode[]>();
    const readDirectory = vi.fn(() => read.promise);
    const adapter = { readDirectory } as unknown as FileSystemAdapter;
    const node = directory();
    const added = vi.fn();
    const view = renderHook(
      () => {
        const folder = useRecursiveFolderSelect({
          fileSystemAdapter: adapter,
          getSubtreeByPath: () => node,
        });
        const all = useRecursiveSelectAll({
          fileSystemAdapter: adapter,
          getCurrentTree: () => [node],
          onTreeUpdate: vi.fn(),
        });
        return { all, folder };
      },
      {
        wrapper: ({ children }) => (
          <registry.wrapper>
            <AdaptersProvider
              fileSystemAdapter={adapter}
              storageAdapter={new MemoryStorageAdapter()}
            >
              {children}
            </AdaptersProvider>
          </registry.wrapper>
        ),
      }
    );
    let selection!: Promise<unknown>;
    act(() => {
      selection =
        kind === 'folder'
          ? view.result.current.folder.selectFolderRecursively(node, 'root', added, 100, 0)
          : view.result.current.all.selectAllRecursively([node], 'root', added, 100);
    });
    await waitFor(() => expect(readDirectory).toHaveBeenCalledOnce());
    let closed = false;
    const closing = registry.close().then(() => {
      closed = true;
    });
    try {
      await tick();
      expect(closed).toBe(false);
    } finally {
      await act(async () => {
        read.resolve([]);
        await selection;
        await closing;
      });
    }
    expect(added).not.toHaveBeenCalled();
    view.unmount();
  }
);

it('joins an admitted restoration and retires its outer expansion commit even if the read resolves normally', async () => {
  const registry = closeRegistry();
  const store = createFileExplorerStore(new MemoryStorageAdapter());
  await waitFor(() => expect(store.persist.hasHydrated()).toBe(true));
  store.setState({ currentFolderId: 'root', expandedDirectoryPaths: new Set(['/repo/src']) });
  await store.drainPersistence();
  const read = Promise.withResolvers<void>();
  const load = vi.fn(() => read.promise);
  const commit = vi.fn();
  const view = renderHook(
    () =>
      useExpandedPathRestoration({
        currentRootFolderId: 'root',
        currentRootPath: '/repo',
        fileTree: [directory()],
        isTreeLoading: false,
        loadSpecificPaths: load,
        setExpandedPaths: commit,
        store,
      }),
    { wrapper: registry.wrapper }
  );
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  let closed = false;
  const closing = registry.close().then(() => {
    closed = true;
  });
  try {
    await tick();
    expect(closed).toBe(false);
  } finally {
    await act(async () => {
      read.resolve();
      await closing;
    });
  }
  expect(commit).not.toHaveBeenCalled();
  view.unmount();
});

it('joins the active forest section and stops the next root from being admitted', async () => {
  const registry = closeRegistry();
  const view = renderHook(() => useOptionalForestTreeActions(), {
    wrapper: ({ children }) => (
      <registry.wrapper>
        <ForestTreeActionsProvider>{children}</ForestTreeActionsProvider>
      </registry.wrapper>
    ),
  });
  const first = Promise.withResolvers<void>();
  const second = vi.fn(async () => {});
  const section = (expandAll: () => Promise<void>) => ({
    cancelExpandAll: vi.fn(),
    expandAll,
    getVisibleQuickFilterKeys: () => [],
    selectAll: vi.fn(async () => ({ limitReached: false, selected: 0 })),
    setCollapsed: vi.fn(),
  });
  act(() => {
    view.result.current!.register(
      'first',
      section(() => first.promise)
    );
    view.result.current!.register('second', section(second));
  });
  let expanding!: Promise<void>;
  act(() => {
    expanding = view.result.current!.runExpandAll();
  });
  let closed = false;
  const closing = registry.close().then(() => {
    closed = true;
  });
  try {
    await tick();
    expect(closed).toBe(false);
  } finally {
    await act(async () => {
      first.resolve();
      await Promise.all([expanding, closing]);
    });
  }
  expect(second).not.toHaveBeenCalled();
  view.unmount();
});
