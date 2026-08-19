import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import type {
  FileContentReadResult,
  FileReadRequest,
} from '@brainstrike/workers/file-content-worker';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { useFileContentLoadAuthority } from '../file-content-load-authority-context';
import { FileExplorerProvider } from '../shell/file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(),
}));

interface PendingWorkerRead {
  readonly complete: (content: string) => void;
  readonly requests: readonly FileReadRequest[];
}

function createPendingWorker(pendingReads: PendingWorkerRead[]) {
  return vi.fn(
    (
      requests: FileReadRequest[],
      onProgress?: (event: { key: string; loaded: number; total: number }) => void
    ) =>
      new Promise<Record<string, FileContentReadResult>>((resolve) => {
        pendingReads.push({
          complete: (content) => {
            const results = Object.fromEntries(
              requests.map((request) => {
                onProgress?.({ key: request.compositeKey, loaded: 1, total: requests.length });
                return [request.compositeKey, { content, status: 'accessible' as const }] as const;
              })
            );
            resolve(results);
          },
          requests,
        });
      })
  );
}

it('runs queued interactive reads before bulk work while bounding bulk starvation', async () => {
  const adapter = new MockFileSystemAdapter();
  const storage = new MemoryStorageAdapter();
  const nodes = [
    ...Array.from({ length: 3 }, (_, batchIndex) =>
      Array.from({ length: 2 }, (_, fileIndex) =>
        createFileNode({
          path: `/bulk-${batchIndex}-${fileIndex}.txt`,
          rootFolderId: 'root-priority',
        })
      )
    ).flat(),
    ...Array.from({ length: 3 }, (_, index) =>
      createFileNode({ path: `/interactive-${index}.txt`, rootFolderId: 'root-priority' })
    ),
  ];
  const keys = nodes.map((node) => encodeFileSelection('root-priority', node.path));
  const bulkA = keys.slice(0, 2);
  const bulkB = keys.slice(2, 4);
  const queuedBulk = keys.slice(4, 6);
  const interactive = keys.slice(6);
  const pendingReads: PendingWorkerRead[] = [];
  const worker = createPendingWorker(pendingReads);
  const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
  vi.mocked(createFileContentWorker).mockReturnValue(worker);

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  }
  const { result } = renderHook(() => useSharedFileContentLoading(nodes), { wrapper: Wrapper });
  let loads: Promise<void>[] = [];
  act(() => {
    loads = [
      result.current.handleFileContentLoading(bulkA, 'background'),
      result.current.handleFileContentLoading(bulkB, 'background'),
      result.current.handleFileContentLoading(queuedBulk, 'background'),
      ...interactive.map((key) => result.current.handleFileContentLoading([key], 'interactive')),
    ];
  });

  await waitFor(() => expect(pendingReads).toHaveLength(2));
  expect(pendingReads[0]?.requests.map((request) => request.compositeKey)).toEqual(bulkA);
  expect(pendingReads[1]?.requests.map((request) => request.compositeKey)).toEqual(bulkB);

  await act(async () => {
    pendingReads[0]?.complete('bulk a');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(3));
  expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([
    interactive[0],
  ]);

  await act(async () => {
    pendingReads[1]?.complete('bulk b');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(4));
  expect(pendingReads[3]?.requests.map((request) => request.compositeKey)).toEqual([
    interactive[1],
  ]);

  await act(async () => {
    pendingReads[2]?.complete('interactive zero');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(5));
  expect(pendingReads[4]?.requests.map((request) => request.compositeKey)).toEqual(queuedBulk);

  await act(async () => {
    pendingReads[3]?.complete('interactive one');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(6));
  expect(pendingReads[5]?.requests.map((request) => request.compositeKey)).toEqual([
    interactive[2],
  ]);

  await act(async () => {
    pendingReads[4]?.complete('queued bulk');
    pendingReads[5]?.complete('interactive two');
    await Promise.all(loads);
  });
});

it('promotes only a queued matching background key without duplicating its physical read', async () => {
  const adapter = new MockFileSystemAdapter();
  const storage = new MemoryStorageAdapter();
  const nodesByName = Object.fromEntries(
    [
      'active-a',
      'active-b',
      'earlier-background',
      'target',
      'hitchhiker',
      'interactive-1',
      'interactive-2',
    ].map((name) => [
      name,
      createFileNode({ path: `/${name}.txt`, rootFolderId: 'root-same-key-promotion' }),
    ])
  );
  const keyFor = (name: string): string => {
    const node = nodesByName[name];
    if (!node) {
      throw new Error(`Missing test node ${name}`);
    }
    return encodeFileSelection('root-same-key-promotion', node.path);
  };
  const nodes = Object.values(nodesByName);
  const activeA = keyFor('active-a');
  const activeB = keyFor('active-b');
  const earlierBackground = keyFor('earlier-background');
  const target = keyFor('target');
  const hitchhiker = keyFor('hitchhiker');
  const interactive1 = keyFor('interactive-1');
  const interactive2 = keyFor('interactive-2');
  const pendingReads: PendingWorkerRead[] = [];
  const worker = createPendingWorker(pendingReads);
  const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
  vi.mocked(createFileContentWorker).mockReturnValue(worker);

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  }
  const { result } = renderHook(() => useSharedFileContentLoading(nodes), { wrapper: Wrapper });
  const loads: Promise<void>[] = [];
  let targetBackground = Promise.resolve();
  let interactiveTarget = Promise.resolve();
  let targetBackgroundSettled = false;
  let interactiveTargetSettled = false;
  act(() => {
    loads.push(result.current.handleFileContentLoading([activeA], 'background'));
    loads.push(result.current.handleFileContentLoading([activeB], 'background'));
    loads.push(result.current.handleFileContentLoading([earlierBackground], 'background'));
    targetBackground = result.current.handleFileContentLoading([target, hitchhiker], 'background');
    loads.push(targetBackground);
    interactiveTarget = result.current.handleFileContentLoading([target], 'interactive');
    loads.push(interactiveTarget);
    loads.push(result.current.handleFileContentLoading([interactive1], 'interactive'));
    loads.push(result.current.handleFileContentLoading([interactive2], 'interactive'));
  });
  void targetBackground.then(() => {
    targetBackgroundSettled = true;
  });
  void interactiveTarget.then(() => {
    interactiveTargetSettled = true;
  });

  await waitFor(() => expect(pendingReads).toHaveLength(2));
  expect(pendingReads[0]?.requests.map((request) => request.compositeKey)).toEqual([activeA]);
  expect(pendingReads[1]?.requests.map((request) => request.compositeKey)).toEqual([activeB]);

  await act(async () => {
    pendingReads[0]?.complete('active a');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(3));
  expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([target]);

  await act(async () => {
    pendingReads[1]?.complete('active b');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(4));
  expect(pendingReads[3]?.requests.map((request) => request.compositeKey)).toEqual([interactive1]);

  await act(async () => {
    pendingReads[2]?.complete('promoted target');
    await interactiveTarget;
  });
  expect(interactiveTargetSettled).toBe(true);
  expect(targetBackgroundSettled).toBe(false);
  await waitFor(() => expect(pendingReads).toHaveLength(5));
  expect(pendingReads[4]?.requests.map((request) => request.compositeKey)).toEqual([
    earlierBackground,
  ]);

  await act(async () => {
    pendingReads[3]?.complete('interactive one');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(6));
  expect(pendingReads[5]?.requests.map((request) => request.compositeKey)).toEqual([interactive2]);

  await act(async () => {
    pendingReads[4]?.complete('earlier background');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(7));
  expect(pendingReads[6]?.requests.map((request) => request.compositeKey)).toEqual([hitchhiker]);

  await act(async () => {
    pendingReads[5]?.complete('interactive two');
    pendingReads[6]?.complete('hitchhiker');
    await Promise.all(loads);
  });
  expect(targetBackgroundSettled).toBe(true);
  const physicallyReadKeys = pendingReads.flatMap((read) =>
    read.requests.map((request) => request.compositeKey)
  );
  expect(physicallyReadKeys.filter((key) => key === target)).toHaveLength(1);
});

it('promotes a queued background reload for Workspace-tab Retry before its predecessor starts', async () => {
  const adapter = new MockFileSystemAdapter();
  const storage = new MemoryStorageAdapter();
  const names = ['active-a', 'active-b', 'earlier-background', 'target'] as const;
  const nodes = names.map((name) =>
    createFileNode({ path: `/${name}.txt`, rootFolderId: 'root-retry-promotion' })
  );
  const keys = Object.fromEntries(
    names.map((name) => [name, encodeFileSelection('root-retry-promotion', `/${name}.txt`)])
  );
  const activeA = keys['active-a'];
  const activeB = keys['active-b'];
  const earlierBackground = keys['earlier-background'];
  const target = keys['target'];
  if (!(activeA && activeB && earlierBackground && target)) {
    throw new Error('Missing Workspace-tab Retry promotion test keys');
  }
  const pendingReads: PendingWorkerRead[] = [];
  const worker = createPendingWorker(pendingReads);
  const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
  vi.mocked(createFileContentWorker).mockReturnValue(worker);

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  }
  const { result } = renderHook(() => useSharedFileContentLoading(nodes), { wrapper: Wrapper });
  let activeLoads: Promise<void>[] = [];
  let earlierLoad = Promise.resolve();
  let backgroundReload = Promise.resolve();
  let interactiveRetry = Promise.resolve();
  let backgroundSettled = false;
  let retrySettled = false;
  act(() => {
    activeLoads = [
      result.current.handleFileContentLoading([activeA], 'background'),
      result.current.handleFileContentLoading([activeB], 'background'),
    ];
    earlierLoad = result.current.handleFileContentLoading([earlierBackground], 'background');
    backgroundReload = result.current.reloadFileContents([target], 'background');
    // WorkspaceTabsProvider routes its user-visible Retry through this exact
    // API/intent pair. It must promote the queued replacement instead of
    // waiting for that background ticket as a predecessor.
    interactiveRetry = result.current.reloadFileContents([target], 'interactive');
  });
  void backgroundReload.then(() => {
    backgroundSettled = true;
  });
  void interactiveRetry.then(() => {
    retrySettled = true;
  });

  await waitFor(() => expect(pendingReads).toHaveLength(2));
  await act(async () => {
    pendingReads[0]?.complete('active a');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(3));
  expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([target]);

  await act(async () => {
    pendingReads[2]?.complete('promoted Retry target');
    await Promise.all([backgroundReload, interactiveRetry]);
  });
  expect(backgroundSettled).toBe(true);
  expect(retrySettled).toBe(true);
  expect(
    pendingReads
      .flatMap((read) => read.requests)
      .filter((request) => request.compositeKey === target)
  ).toHaveLength(1);

  await waitFor(() => expect(pendingReads).toHaveLength(4));
  await act(async () => {
    pendingReads[1]?.complete('active b');
    pendingReads[3]?.complete('earlier background');
    await Promise.all([...activeLoads, earlierLoad]);
  });
});

it.each([
  { backgroundShape: 'singleton', includeHitchhiker: false },
  { backgroundShape: 'multi-key', includeHitchhiker: true },
])(
  'extracts $backgroundShape background promotion into the same interactive FIFO tail',
  async ({ includeHitchhiker }) => {
    const adapter = new MockFileSystemAdapter();
    const storage = new MemoryStorageAdapter();
    const names = [
      'active-a',
      'active-b',
      'target',
      'hitchhiker',
      'interactive-1',
      'interactive-2',
    ] as const;
    const nodes = names.map((name) =>
      createFileNode({ path: `/${name}.txt`, rootFolderId: 'root-promotion-fifo' })
    );
    const keys = Object.fromEntries(
      names.map((name) => [name, encodeFileSelection('root-promotion-fifo', `/${name}.txt`)])
    );
    const activeA = keys['active-a'];
    const activeB = keys['active-b'];
    const target = keys['target'];
    const hitchhiker = keys['hitchhiker'];
    const interactive1 = keys['interactive-1'];
    const interactive2 = keys['interactive-2'];
    if (!(activeA && activeB && target && hitchhiker && interactive1 && interactive2)) {
      throw new Error('Missing promotion FIFO test keys');
    }
    const pendingReads: PendingWorkerRead[] = [];
    const worker = createPendingWorker(pendingReads);
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    function Wrapper({ children }: { readonly children: ReactNode }) {
      return (
        <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
          <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
        </AdaptersProvider>
      );
    }
    const { result } = renderHook(() => useSharedFileContentLoading(nodes), { wrapper: Wrapper });
    let loads: Promise<void>[] = [];
    act(() => {
      const backgroundKeys = includeHitchhiker ? [target, hitchhiker] : [target];
      loads = [
        result.current.handleFileContentLoading([activeA], 'background'),
        result.current.handleFileContentLoading([activeB], 'background'),
        result.current.handleFileContentLoading(backgroundKeys, 'background'),
        result.current.handleFileContentLoading([interactive1], 'interactive'),
        result.current.handleFileContentLoading([interactive2], 'interactive'),
        result.current.handleFileContentLoading([target], 'interactive'),
      ];
    });

    await waitFor(() => expect(pendingReads).toHaveLength(2));
    await act(async () => {
      pendingReads[0]?.complete('active a');
      await Promise.resolve();
    });
    await waitFor(() => expect(pendingReads).toHaveLength(3));
    expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([
      interactive1,
    ]);

    await act(async () => {
      pendingReads[1]?.complete('active b');
      await Promise.resolve();
    });
    await waitFor(() => expect(pendingReads).toHaveLength(4));
    expect(pendingReads[3]?.requests.map((request) => request.compositeKey)).toEqual([
      interactive2,
    ]);

    await act(async () => {
      pendingReads[2]?.complete('interactive one');
      await Promise.resolve();
    });
    await waitFor(() => expect(pendingReads).toHaveLength(5));
    const afterFirstInteractive = includeHitchhiker ? hitchhiker : target;
    expect(pendingReads[4]?.requests.map((request) => request.compositeKey)).toEqual([
      afterFirstInteractive,
    ]);

    await act(async () => {
      pendingReads[3]?.complete('interactive two');
      await Promise.resolve();
    });
    if (includeHitchhiker) {
      await waitFor(() => expect(pendingReads).toHaveLength(6));
      expect(pendingReads[5]?.requests.map((request) => request.compositeKey)).toEqual([target]);
    }

    await act(async () => {
      pendingReads[4]?.complete(includeHitchhiker ? 'hitchhiker' : 'promoted target');
      if (includeHitchhiker) {
        pendingReads[5]?.complete('promoted target');
      }
      await Promise.all(loads);
    });
    expect(
      pendingReads
        .flatMap((read) => read.requests)
        .filter((request) => request.compositeKey === target)
    ).toHaveLength(1);
  }
);

it('settles promoted tickets once on reset and permits a fresh same-key schedule', async () => {
  const adapter = new MockFileSystemAdapter();
  const storage = new MemoryStorageAdapter();
  const names = ['active-a', 'active-b', 'target', 'hitchhiker'] as const;
  const nodes = names.map((name) =>
    createFileNode({ path: `/${name}.txt`, rootFolderId: 'root-promotion-reset' })
  );
  const keys = Object.fromEntries(
    names.map((name) => [name, encodeFileSelection('root-promotion-reset', `/${name}.txt`)])
  );
  const activeA = keys['active-a'];
  const activeB = keys['active-b'];
  const target = keys['target'];
  const hitchhiker = keys['hitchhiker'];
  if (!(activeA && activeB && target && hitchhiker)) {
    throw new Error('Missing reset test keys');
  }
  const pendingReads: PendingWorkerRead[] = [];
  const worker = createPendingWorker(pendingReads);
  const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
  vi.mocked(createFileContentWorker).mockReturnValue(worker);

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  }
  const { result, unmount } = renderHook(
    () => ({
      authority: useFileContentLoadAuthority(),
      loader: useSharedFileContentLoading(nodes),
    }),
    { wrapper: Wrapper }
  );
  let originalLoads: Promise<void>[] = [];
  act(() => {
    originalLoads = [
      result.current.loader.handleFileContentLoading([activeA], 'background'),
      result.current.loader.handleFileContentLoading([activeB], 'background'),
      result.current.loader.handleFileContentLoading([target, hitchhiker], 'background'),
      result.current.loader.handleFileContentLoading([target], 'interactive'),
    ];
  });
  const settlementCounts = originalLoads.map(() => 0);
  for (const [index, load] of originalLoads.entries()) {
    void load.then(
      () => {
        settlementCounts[index] = (settlementCounts[index] ?? 0) + 1;
      },
      () => {
        settlementCounts[index] = (settlementCounts[index] ?? 0) + 1;
      }
    );
  }
  await waitFor(() => expect(pendingReads).toHaveLength(2));

  act(() => {
    result.current.authority.invalidateAll();
  });
  await act(async () => {
    await Promise.allSettled(originalLoads);
  });
  expect(settlementCounts).toEqual([1, 1, 1, 1]);

  let replacementLoad = Promise.resolve();
  act(() => {
    replacementLoad = result.current.loader.handleFileContentLoading([target], 'interactive');
  });
  await waitFor(() => expect(pendingReads).toHaveLength(3));
  expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([target]);

  await act(async () => {
    pendingReads[2]?.complete('replacement target');
    await replacementLoad;
    pendingReads[0]?.complete('late active a');
    pendingReads[1]?.complete('late active b');
    await Promise.resolve();
  });
  expect(settlementCounts).toEqual([1, 1, 1, 1]);
  expect(
    pendingReads
      .flatMap((read) => read.requests)
      .filter((request) => request.compositeKey === target)
  ).toHaveLength(1);
  expect(
    pendingReads
      .flatMap((read) => read.requests)
      .filter((request) => request.compositeKey === hitchhiker)
  ).toHaveLength(0);
  unmount();
});

it('preserves background intent across twenty singleton reload groups ahead of real interactive work', async () => {
  const adapter = new MockFileSystemAdapter();
  const storage = new MemoryStorageAdapter();
  const backgroundNodes = Array.from({ length: 20 }, (_, index) =>
    createFileNode({ path: `/background-${index}.txt`, rootFolderId: 'root-logical-priority' })
  );
  const interactiveNodes = Array.from({ length: 3 }, (_, index) =>
    createFileNode({ path: `/interactive-${index}.txt`, rootFolderId: 'root-logical-priority' })
  );
  const nodes = [...backgroundNodes, ...interactiveNodes];
  const backgroundKeys = backgroundNodes.map((node) =>
    encodeFileSelection('root-logical-priority', node.path)
  );
  const interactiveKeys = interactiveNodes.map((node) =>
    encodeFileSelection('root-logical-priority', node.path)
  );
  const pendingReads: PendingWorkerRead[] = [];
  const worker = createPendingWorker(pendingReads);
  const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
  vi.mocked(createFileContentWorker).mockReturnValue(worker);

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  }
  const { result } = renderHook(
    () => ({
      authority: useFileContentLoadAuthority(),
      loader: useSharedFileContentLoading(nodes),
    }),
    { wrapper: Wrapper }
  );
  const resolvePredecessors: Array<() => void> = [];
  for (const compositeKey of backgroundKeys) {
    let resolvePredecessor: (() => void) | undefined;
    const predecessor = new Promise<void>((resolve) => {
      resolvePredecessor = resolve;
    });
    let trackedPredecessor: Promise<void>;
    trackedPredecessor = predecessor.finally(() => {
      result.current.authority.releaseActiveLoad([compositeKey], trackedPredecessor);
    });
    result.current.authority.trackActiveLoad([compositeKey], trackedPredecessor);
    resolvePredecessors.push(() => resolvePredecessor?.());
  }

  let backgroundReload: Promise<void> | undefined;
  act(() => {
    backgroundReload = result.current.loader.reloadFileContents(backgroundKeys, 'background');
    for (const resolvePredecessor of resolvePredecessors) {
      resolvePredecessor();
    }
  });
  await waitFor(() => expect(pendingReads).toHaveLength(2));

  let interactiveLoads: Promise<void>[] = [];
  act(() => {
    interactiveLoads = interactiveKeys.map((key) =>
      result.current.loader.handleFileContentLoading([key], 'interactive')
    );
  });

  await act(async () => {
    pendingReads[0]?.complete('first background');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(3));
  expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([
    interactiveKeys[0],
  ]);

  await act(async () => {
    pendingReads[1]?.complete('second background');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(4));
  expect(pendingReads[3]?.requests.map((request) => request.compositeKey)).toEqual([
    interactiveKeys[1],
  ]);

  await act(async () => {
    pendingReads[2]?.complete('first interactive');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(5));
  expect(pendingReads[4]?.requests.map((request) => request.compositeKey)).toEqual([
    backgroundKeys[2],
  ]);

  for (let index = 3; index < backgroundKeys.length + interactiveKeys.length; index += 1) {
    await act(async () => {
      pendingReads[index]?.complete(`completion ${index}`);
      await Promise.resolve();
    });
    if (index < backgroundKeys.length + interactiveKeys.length - 1) {
      await waitFor(() => expect(pendingReads.length).toBeGreaterThan(index + 1));
    }
  }
  await act(async () => {
    await Promise.all([backgroundReload, ...interactiveLoads]);
  });
});
