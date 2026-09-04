/**
 * useWorkspaceBar's shared metadata-write-tail chaining — making a secondary
 * primary and immediately making the just-demoted root primary again,
 * creating a worktree and handing the thread back to local while that first
 * write is still in flight, a newly selected thread deriving its write from
 * ITS OWN folders rather than the previous thread's tail, deriving from the
 * live folder set once the queue has drained, and two rapid Make primary
 * clicks chaining rather than racing. All of these pin the
 * `updateThreadMetadata` serialization queue so the second action derives
 * from the first write.
 *
 * Split out of `use-workspace-bar.test.tsx`, which crossed Biome's 1000-line
 * cap (twice — the derive/chain trio above moved here in the second split,
 * once this file's own shared theme made it their natural home). The shared
 * fixtures below are duplicated rather than imported: each Vitest file needs
 * its OWN `vi.mock`/`vi.hoisted` registrations (mocking is scoped per test
 * file, so a hoisted spy cannot be shared by reference across files), and
 * everything else here participates in that per-file mock setup
 * (`beforeEach` resets it, `setup()` renders through it) closely enough that
 * splitting it out would just relocate the same coupling rather than remove
 * it. Helpers and fixtures unused on this side (`openLiveRootGate`,
 * `isSecondaryLookup`, `revealLabel`) were dropped rather than carried over
 * dead.
 */
import type {
  AssistantThreadMetadata,
  AssistantThreadRepository,
} from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { WorkspaceBarBranchMenu } from '@brainstrike/assistant-ui';
import type { ActionOutcome } from '@brainstrike/context-actions';
import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useWorkspaceBar } from '../hooks/use-workspace-bar';

// `fs` is only dereferenced when the mocked useFileSystem() is CALLED (render
// time), so vitest's vi.mock hoisting above these imports is safe.
const fs = {
  addRootDirectory: vi.fn(async () => ({
    kind: 'directory',
    name: 'docs',
    path: '/ws/docs',
    platform: 'electron',
    rootId: 'adapter-docs',
  })),
  addRootDirectoryByPath: vi.fn(async (p: string) => ({
    kind: 'directory',
    name: 'alpha',
    path: p,
    platform: 'electron',
    rootId: 'adapter-alpha',
  })),
  // BST-1393 L2: useConnectFolder() (now reached via useFolderDrop() inside
  // useWorkspaceBar()) calls this unconditionally to gate openPicker.
  isFileSystemAccessSupported: vi.fn(() => ({ reason: '', supported: true })),
  listRecentRoots: vi.fn(async () => [
    { displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' },
    { displayName: 'brainstrike', lastGrantedAt: 2, path: '/ws/brainstrike' },
  ]),
};
// Web omits the desktop-only capabilities rather than stubbing them.
const webFs: Pick<typeof fs, 'addRootDirectory' | 'isFileSystemAccessSupported'> &
  Partial<Pick<typeof fs, 'addRootDirectoryByPath' | 'listRecentRoots'>> = {
  addRootDirectory: fs.addRootDirectory,
  isFileSystemAccessSupported: fs.isFileSystemAccessSupported,
};
let currentFs: typeof fs | typeof webFs = fs;
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({ useFileSystem: () => currentFs }));

// The reveal affordance is capability-gated on the real `window.platform`
// bridge — installed here rather than mocked so the capability check under
// test is the production one.
const showItemInFolder = vi.fn(async () => ({ ok: true }));

const {
  branchSwitcherSpy,
  checkoutSpy,
  clipboardWriteText,
  forgePrSpy,
  loggerMock,
  toastSpy,
  worktreeArchiveSpy,
  worktreeCreateSpy,
  worktreeListSpy,
} = vi.hoisted(() => ({
  branchSwitcherSpy: vi.fn(),
  checkoutSpy: vi.fn(
    (
      _root: {
        readonly adapterRootId: string | null;
        readonly dbRootId: string;
        readonly path: string;
      } | null
    ) => ({
      checkout: {
        ahead: 0,
        behind: 0,
        branch: 'main',
        dirty: false,
      },
      settled: true,
    })
  ),
  clipboardWriteText: vi.fn(),
  forgePrSpy: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
  toastSpy: vi.fn(),
  worktreeArchiveSpy: vi.fn(),
  worktreeCreateSpy: vi.fn(),
  worktreeListSpy: vi.fn(),
}));

vi.mock('../hooks/use-branch-switcher', () => ({ useBranchSwitcher: branchSwitcherSpy }));
vi.mock('../hooks/use-thread-forge-pr', () => ({ useThreadForgePr: forgePrSpy }));
vi.mock('../hooks/use-thread-checkout-status', () => ({ useThreadCheckoutStatus: checkoutSpy }));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));
// The STANDALONE `toast` export, not `useToast()`: the bar raises toasts but
// never renders the toast list, so it must not subscribe to the store.
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastSpy,
}));
vi.mock('@brainstrike/context-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/context-actions')>()),
  createClipboardService: () => ({ writeText: clipboardWriteText }),
}));

const branchMenu = {
  onCreateBranch: vi.fn(),
  onFetch: undefined,
  onQueryChange: vi.fn(),
  onSwitch: vi.fn(),
  pending: false,
  query: '',
  rows: [],
  scopeReason: null,
} satisfies WorkspaceBarBranchMenu;

const RESOURCE_ID = 'workspace-a';
const THREAD_ID = 'thread-1';
const OTHER_THREAD_ID = 'thread-2';

// The DURABLE `roots.id` per path. Deliberately DIFFERENT from the adapter
// rootIds above (`adapter-*`) and from the descriptor id below: the two id
// spaces share only the path, and everything downstream of this hook
// (window.git.status, secondaryRootIds) speaks the DB space.
const ROOT_ID_BY_PATH: Readonly<Record<string, string>> = {
  '/managed/brainstrike/bright-fox': 'r-worktree-db',
  '/ws/alpha': 'r-alpha-db',
  '/ws/brainstrike': 'r-main-db',
  '/ws/docs': 'r-docs',
  '/ws/site': 'r-site',
};
const ROOT_ROW_BY_ID: Readonly<Record<string, { displayName: string; path: string }>> = {
  'r-alpha-db': { displayName: 'alpha', path: '/ws/alpha' },
  'r-docs': { displayName: 'docs', path: '/ws/docs' },
  'r-main-db': { displayName: 'brainstrike', path: '/ws/brainstrike' },
  'r-site': { displayName: 'site', path: '/ws/site' },
  'r-worktree-db': {
    displayName: 'bright-fox',
    path: '/managed/brainstrike/bright-fox',
  },
};
// How many times the live-root probe for a path must MISS before the row
// appears — models roots reconciliation writing the row after the add resolves.
const liveRootMisses = new Map<string, number>();
// Holds the live-root probe open so a test can land a thread switch WHILE the
// final lookup is in flight (the window a retry-loop-only cancellation check
// cannot see).
let liveRootGate: { promise: Promise<void>; release: () => void } | null = null;

const query = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes('FROM roots') && sql.includes('= ANY')) {
    const ids = (params?.[0] ?? []) as readonly string[];
    return {
      rows: ids.flatMap((id) => {
        const row = ROOT_ROW_BY_ID[id];
        return row ? [{ displayName: row.displayName, id, path: row.path }] : [];
      }),
    };
  }
  if (sql.includes('FROM roots')) {
    if (liveRootGate) {
      await liveRootGate.promise;
    }
    // PATH-specific on purpose: an "add folder" test must not pass by
    // resolving some other root's row.
    const path = params?.[0] as string;
    const misses = liveRootMisses.get(path) ?? 0;
    if (misses > 0) {
      liveRootMisses.set(path, misses - 1);
      return { rows: [] };
    }
    const id = ROOT_ID_BY_PATH[path];
    return { rows: id ? [{ id }] : [] };
  }
  return { rows: [] };
});
// The store action forwards to `repository.updateThreadMetadata(threadId,
// metadata)`, so this spy sees the REPOSITORY signature — which is exactly the
// persisted payload worth pinning.
const updateThreadMetadata = vi.fn(
  async (_threadId: string, _metadata: AssistantThreadMetadata) => {}
);
// The real store action, restored per test: one case below swaps it for a
// persist-only forwarder to model the window where a write has landed in the
// repository but its store update has not reached React yet.
const realUpdateThreadMetadata = useAssistantThreadStore.getState().updateThreadMetadata;
// Hoisted on purpose: the wrapper passes store/context references, which are
// stable across renders. Fresh literals per render would only exercise a
// caller-side identity bug, not this hook.
const database = { query } as unknown as DbHandle;
const assistantThreadRepository = {
  updateThreadMetadata,
} as unknown as AssistantThreadRepository;
const currentMainRoot = { displayName: 'brainstrike', path: '/ws/brainstrike' };
// Keyed by the file-explorer ADAPTER rootId (the production store builds it as
// `Object.fromEntries(roots.map((r) => [r.rootId, r]))`). It is deliberately
// UNRELATED to the DB `roots.id` above: the durable id must never be borrowed
// as an adapter id, nor the reverse.
const rootDescriptors = {
  'adapter-main': { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'adapter-main' },
};

interface SeededThread {
  readonly id: string;
  readonly metadata: Record<string, unknown>;
}

function seedThreads(threads: readonly SeededThread[], selectedId: string) {
  useAssistantThreadStore.setState({
    ...useAssistantThreadStore.getState(),
    selectedThreadByResourceId: { [RESOURCE_ID]: selectedId },
    threadsByResourceId: {
      [RESOURCE_ID]: threads.map((thread) => ({
        createdAt: new Date(),
        id: thread.id,
        metadata: thread.metadata,
        resourceId: RESOURCE_ID,
        title: 't',
        updatedAt: new Date(),
      })),
    },
  });
}

function seedThread(metadata: Record<string, unknown>) {
  seedThreads([{ id: THREAD_ID, metadata }], THREAD_ID);
}

function installWorktreesBridge(): void {
  (window as Window & { worktrees?: unknown }).worktrees = {
    adopt: vi.fn(),
    archive: worktreeArchiveSpy,
    checkoutStatus: vi.fn(),
    create: worktreeCreateSpy,
    createBranchHere: vi.fn(),
    createContext: vi.fn(async () => ({
      ok: true as const,
      value: {
        managedParentPath: '/managed/brainstrike-slug',
        repositorySetup: null,
        suggestedName: 'bright-fox',
      },
    })),
    getSettings: vi.fn(async () => ({
      ok: true as const,
      value: {
        isDefaultDirectory: true,
        managedDirectory: '/managed',
        setupCommand: null,
      },
    })),
    inspectArchive: vi.fn(async () => ({
      ok: true as const,
      value: {
        confirmationToken: null,
        ignoredEntryCount: 0,
        ignoredTopLevelEntries: [],
        ignoredTopLevelEntriesTruncated: false,
        ignoredTopLevelEntryCount: 0,
      },
    })),
    list: worktreeListSpy,
    listManagedPaths: vi.fn(),
    restore: vi.fn(),
    setSettings: vi.fn(),
  };
}

/** Flush the microtask chain a queued metadata write runs on. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

interface BarProps {
  readonly selectedMemoryThreadId: string | undefined;
}

async function setup(metadata: Record<string, unknown> = {}) {
  seedThread(metadata);
  const rendered = renderHook(
    (props: BarProps) =>
      useWorkspaceBar({
        assistantThreadRepository,
        currentMainRoot,
        database,
        memoryResourceId: RESOURCE_ID,
        rootDescriptors,
        selectedMemoryThreadId: props.selectedMemoryThreadId,
      }),
    { initialProps: { selectedMemoryThreadId: THREAD_ID } as BarProps }
  );
  // Let the mount-time roots/recents reads settle inside act so no state
  // update escapes the test's act() scope.
  await act(async () => {});
  return rendered;
}

beforeEach(() => {
  Reflect.deleteProperty(window, 'worktrees');
  (window as Window & { platform?: unknown }).platform = {
    openExternal: vi.fn(async () => ({ ok: true })),
    openPath: vi.fn(async () => ({ ok: true })),
    showItemInFolder,
  };
  showItemInFolder.mockClear();
  useAssistantThreadStore.setState({ updateThreadMetadata: realUpdateThreadMetadata });
  currentFs = fs;
  liveRootMisses.clear();
  liveRootGate = null;
  useChangesLiveRefreshStore.getState().reset();
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue({ ok: true } satisfies ActionOutcome);
  branchSwitcherSpy.mockReset();
  branchSwitcherSpy.mockReturnValue(branchMenu);
  checkoutSpy.mockClear();
  forgePrSpy.mockReset();
  forgePrSpy.mockReturnValue({ diagnostic: null, refresh: vi.fn(), status: null });
  toastSpy.mockClear();
  worktreeArchiveSpy.mockReset();
  worktreeCreateSpy.mockReset();
  worktreeListSpy.mockReset();
  worktreeListSpy.mockResolvedValue({ ok: true, value: [] });
  loggerMock.debug.mockClear();
  loggerMock.error.mockClear();
  loggerMock.warn.mockClear();
  query.mockClear();
  updateThreadMetadata.mockClear();
  fs.addRootDirectory.mockClear();
  fs.addRootDirectoryByPath.mockClear();
  fs.listRecentRoots.mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'platform');
  Reflect.deleteProperty(window, 'worktrees');
  vi.useRealTimers();
});

describe('useWorkspaceBar — write tail chaining', () => {
  it('atomically leaves Worktree mode and rejects stale re-promotion of the detached worktree', async () => {
    installWorktreesBridge();
    const { result, unmount } = await setup({
      checkoutBranch: 'bs/bright-fox',
      checkoutLocalRootId: 'r-main-db',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/brainstrike/bright-fox',
      operatingRootDisplayName: 'bright-fox',
      operatingRootId: 'r-worktree-db',
      operatingRootPath: '/managed/brainstrike/bright-fox',
      secondaryRootIds: ['r-main-db', 'r-docs'],
    });
    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(2));

    act(() => {
      result.current.onMakePrimary('r-docs');
    });

    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        checkoutMode: 'local',
        operatingRootDisplayName: 'docs',
        operatingRootId: 'r-docs',
        operatingRootPath: '/ws/docs',
        secondaryRootIds: ['r-main-db'],
      })
    );
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: '“docs” is primary. The former worktree is no longer attached to this thread.',
        title: 'Thread is Local again',
      })
    );
    const stored = useAssistantThreadStore
      .getState()
      .threadsByResourceId[RESOURCE_ID]?.find((thread) => thread.id === THREAD_ID);
    expect(stored?.metadata).toEqual({
      checkoutMode: 'local',
      operatingRootDisplayName: 'docs',
      operatingRootId: 'r-docs',
      operatingRootPath: '/ws/docs',
      secondaryRootIds: ['r-main-db'],
    });

    act(() => {
      result.current.onMakePrimary('r-worktree-db');
    });
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description:
          'Could not make primary: secondary root r-worktree-db is unknown or has no path.',
        title: 'Make primary failed',
        variant: 'destructive',
      })
    );
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);

    const persistedMetadata = stored?.metadata;
    if (!persistedMetadata) {
      throw new Error('Make primary did not update the loaded thread metadata');
    }
    unmount();
    // The assistant-data repository integration suite separately pins that a
    // Local transition deletes these same checkout-only keys from the row.
    const reloaded = await setup({ ...persistedMetadata });
    await waitFor(() => expect(reloaded.result.current.primaryRoot?.rootId).toBe('r-docs'));
    expect(reloaded.result.current.mode?.worktree).toBeNull();
  });

  it('preserves the worktree record and primary when the atomic transition fails', async () => {
    const priorMetadata = {
      checkoutBranch: 'bs/bright-fox',
      checkoutLocalRootId: 'r-main-db',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/brainstrike/bright-fox',
      operatingRootDisplayName: 'bright-fox',
      operatingRootId: 'r-worktree-db',
      operatingRootPath: '/managed/brainstrike/bright-fox',
      secondaryRootIds: ['r-main-db', 'r-docs'],
    } as const;
    updateThreadMetadata.mockRejectedValueOnce(new Error('The thread database is read-only.'));
    const { result } = await setup(priorMetadata);
    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(2));

    act(() => {
      result.current.onMakePrimary('r-docs');
    });

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'The thread database is read-only.',
        title: 'Make primary failed',
        variant: 'destructive',
      })
    );
    expect(result.current.primaryRoot?.rootId).toBe('r-worktree-db');
    const stored = useAssistantThreadStore
      .getState()
      .threadsByResourceId[RESOURCE_ID]?.find((thread) => thread.id === THREAD_ID);
    expect(stored?.metadata).toEqual(priorMetadata);
  });

  it('protects only the tracked Local secondary from removal in worktree mode', async () => {
    const { result } = await setup({
      checkoutLocalRootId: 'r-main-db',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/brainstrike/bright-fox',
      operatingRootDisplayName: 'bright-fox',
      operatingRootId: 'r-worktree-db',
      operatingRootPath: '/managed/brainstrike/bright-fox',
      secondaryRootIds: ['r-main-db', 'r-docs'],
    });

    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(2));
    expect(result.current.secondaryRoots).toEqual([
      {
        displayName: 'brainstrike',
        path: '/ws/brainstrike',
        removeDisabledReason: 'This folder is where Hand off returns to.',
        rootId: 'r-main-db',
      },
      { displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' },
    ]);

    act(() => {
      result.current.onRemoveSecondary('r-docs');
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        secondaryRootIds: ['r-main-db'],
      })
    );
  });

  it('chains Make primary back to the root the first click just demoted', async () => {
    vi.useFakeTimers();
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs'],
    });
    await flush();
    expect(result.current.secondaryRoots).toHaveLength(1);
    await act(async () => {
      useAssistantThreadStore.setState({
        updateThreadMetadata: async (
          repository: AssistantThreadRepository,
          _resourceId: string,
          threadId: string,
          metadata: AssistantThreadMetadata
        ) => {
          await repository.updateThreadMetadata(threadId, metadata);
        },
      });
    });

    await act(async () => {
      result.current.onMakePrimary('r-docs');
      result.current.onMakePrimary('r-main-db');
    });
    await flush();

    expect(updateThreadMetadata).toHaveBeenNthCalledWith(1, THREAD_ID, {
      operatingRootDisplayName: 'docs',
      operatingRootId: 'r-docs',
      operatingRootPath: '/ws/docs',
      secondaryRootIds: ['r-main-db'],
    });
    expect(updateThreadMetadata).toHaveBeenNthCalledWith(2, THREAD_ID, {
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs'],
    });
    expect(updateThreadMetadata).toHaveBeenCalledTimes(2);
  });

  it('chains worktree selection into hand-off using the shared write tail', async () => {
    installWorktreesBridge();
    worktreeCreateSpy.mockResolvedValue({
      ok: true,
      value: {
        setup: {
          copiedPaths: [],
          output: '',
          reason: null,
          skippedCopies: [],
          status: 'none',
          truncated: false,
        },
        worktree: {
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'main',
          branch: 'bs/bright-fox',
          createdAt: '2026-08-25T00:00:00.000Z',
          createdBy: 'user',
          id: 'w-1',
          path: '/managed/brainstrike/bright-fox',
          repoCommonDir: '/ws/brainstrike/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: THREAD_ID,
        },
      },
    });
    let releaseFirstWrite = (): void => undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWrite = true;
    useAssistantThreadStore.setState({
      updateThreadMetadata: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadId: string,
        metadata: AssistantThreadMetadata
      ) => {
        await realUpdateThreadMetadata(repository, resourceId, threadId, metadata);
        if (firstWrite) {
          firstWrite = false;
          await firstWriteGate;
        }
      },
    });
    const { result } = await setup();
    await waitFor(() => expect(result.current.mode?.createDisabledReason).toBeNull());

    let createPromise: Promise<void> | undefined;
    act(() => {
      createPromise = result.current.mode?.onCreate({
        baseRef: 'main',
        branch: { name: 'bs/bright-fox' },
        name: 'bright-fox',
      });
    });
    await waitFor(() => expect(result.current.mode?.onHandOffToLocal).toBeDefined());
    act(() => {
      result.current.mode?.onHandOffToLocal?.();
      releaseFirstWrite();
    });
    await act(async () => {
      await createPromise;
    });
    await waitFor(() => expect(updateThreadMetadata).toHaveBeenCalledTimes(2));

    expect(updateThreadMetadata).toHaveBeenNthCalledWith(1, THREAD_ID, {
      checkoutBranch: 'bs/bright-fox',
      checkoutLocalRootId: 'r-main-db',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/brainstrike/bright-fox',
      operatingRootDisplayName: 'bright-fox',
      operatingRootId: 'r-worktree-db',
      operatingRootPath: '/managed/brainstrike/bright-fox',
      secondaryRootIds: ['r-main-db'],
    });
    expect(updateThreadMetadata).toHaveBeenNthCalledWith(2, THREAD_ID, {
      checkoutMode: 'local',
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: [],
    });
  });

  it('resolves a queued worktree selection when a thread switch makes the write obsolete', async () => {
    installWorktreesBridge();
    worktreeCreateSpy.mockResolvedValue({
      ok: true,
      value: {
        setup: {
          copiedPaths: [],
          output: '',
          reason: null,
          skippedCopies: [],
          status: 'none',
          truncated: false,
        },
        worktree: {
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'main',
          branch: 'bs/bright-fox',
          createdAt: '2026-08-25T00:00:00.000Z',
          createdBy: 'user',
          id: 'w-1',
          path: '/managed/brainstrike/bright-fox',
          repoCommonDir: '/ws/brainstrike/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: THREAD_ID,
        },
      },
    });
    let releaseFirstWrite = (): void => undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    useAssistantThreadStore.setState({
      updateThreadMetadata: async (
        repository: AssistantThreadRepository,
        _resourceId: string,
        threadId: string,
        metadata: AssistantThreadMetadata
      ) => {
        await repository.updateThreadMetadata(threadId, metadata);
        await firstWriteGate;
      },
    });
    const { rerender, result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs'],
    });
    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(1));
    await waitFor(() => expect(result.current.mode?.createDisabledReason).toBeNull());

    act(() => {
      result.current.onMakePrimary('r-docs');
    });
    await waitFor(() => expect(updateThreadMetadata).toHaveBeenCalledTimes(1));

    let createPromise: Promise<void> | undefined;
    act(() => {
      createPromise = result.current.mode?.onCreate({
        baseRef: 'main',
        branch: { name: 'bs/bright-fox' },
        name: 'bright-fox',
      });
    });
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM roots'), [
        '/managed/brainstrike/bright-fox',
      ])
    );
    await act(async () => {});

    act(() => {
      rerender({ selectedMemoryThreadId: 'thread-2' });
    });
    releaseFirstWrite();

    await act(async () => {
      await expect(createPromise).resolves.toBeUndefined();
    });
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
    expect(toastSpy).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it("derives a newly selected thread's write from ITS folders, never the previous thread's write tail", async () => {
    vi.useFakeTimers();
    const { rerender, result } = await setup({ secondaryRootIds: ['r-docs', 'r-site'] });
    await flush();
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: ['r-site'],
    });
    // Thread 2 is selected and carries its OWN folder set. The hook is
    // long-lived in the wrapper, so every ref survives the switch.
    await act(async () => {
      seedThreads(
        [
          { id: THREAD_ID, metadata: { secondaryRootIds: ['r-site'] } },
          { id: OTHER_THREAD_ID, metadata: { secondaryRootIds: ['r-alpha-db', 'r-main-db'] } },
        ],
        OTHER_THREAD_ID
      );
      rerender({ selectedMemoryThreadId: OTHER_THREAD_ID });
    });
    await flush();
    await act(async () => {
      result.current.onRemoveSecondary('r-alpha-db');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(OTHER_THREAD_ID, {
      secondaryRootIds: ['r-main-db'],
    });
  });

  it('derives from the LIVE folder set once the write queue has drained', async () => {
    vi.useFakeTimers();
    const { result } = await setup({ secondaryRootIds: ['r-docs', 'r-site'] });
    await flush();
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: ['r-site'],
    });
    // The queue is idle, and another surface has since changed the thread's
    // folders: the next write must read the live set, not the drained tail.
    await act(async () => {
      seedThread({ secondaryRootIds: ['r-site', 'r-alpha-db'] });
    });
    await flush();
    await act(async () => {
      result.current.onRemoveSecondary('r-site');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: ['r-alpha-db'],
    });
  });

  // BST-1400 item 2's tail-retirement rule, pinned against the three-case
  // matrix its per-dimension revision tracking (v4) exists to satisfy — see
  // `use-workspace-bar-write-tail-queue.ts`'s module docblock for the full
  // table and the documented residual it does NOT cover:
  //   v1 (below)       — ref hasn't caught up on the touched field at all → tail HELD
  //   v2 (below)       — a THIRD PARTY changes the SAME field the write touched → tail RETIRES
  //   v3 (further down) — an UNRELATED field bumps while the touched field stays stale → tail HELD
  it('keeps chaining off the tail after it settles until the live ref actually reflects it (BST-1400 item 2)', async () => {
    vi.useFakeTimers();
    const { result } = await setup({ secondaryRootIds: ['r-docs', 'r-site'] });
    await flush();
    // Model the production window where a write PERSISTS but its store
    // update never reaches this render — threadFoldersRef never resyncs on
    // its own for the rest of this test, so the tail is the ONLY correct
    // source for what the first write actually did.
    await act(async () => {
      useAssistantThreadStore.setState({
        updateThreadMetadata: async (
          repository: AssistantThreadRepository,
          _resourceId: string,
          threadId: string,
          metadata: AssistantThreadMetadata
        ) => {
          await repository.updateThreadMetadata(threadId, metadata);
        },
      });
    });
    // First write settles — flushed to completion, in its OWN act(), so the
    // write queue fully drains (pendingWriteCountRef back to 0) before the
    // second click. A tail retired the instant the queue drains, without
    // waiting for the live ref to catch up, would already be gone here.
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: ['r-site'],
    });
    // Second click, enqueued well after the first settled. Deriving from a
    // stale live ref (unaware r-docs was just removed) would resurrect it;
    // deriving from the tail correctly starts from ['r-site'] only.
    await act(async () => {
      result.current.onRemoveSecondary('r-site');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: [],
    });
  });

  it('retires a pinned tail once the live ref resyncs to something ELSE, letting the external change win (BST-1400 item 2 review fold-in)', async () => {
    vi.useFakeTimers();
    const { result } = await setup({ secondaryRootIds: ['r-docs', 'r-site'] });
    await flush();
    // Same persist-only forwarder as the sibling test above, so the first
    // write's OWN change never reaches threadFoldersRef on its own — only an
    // explicit seedThread below moves it.
    await act(async () => {
      useAssistantThreadStore.setState({
        updateThreadMetadata: async (
          repository: AssistantThreadRepository,
          _resourceId: string,
          threadId: string,
          metadata: AssistantThreadMetadata
        ) => {
          await repository.updateThreadMetadata(threadId, metadata);
        },
      });
    });
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: ['r-site'],
    });
    // An EXTERNAL surface changes the thread's folders to a set that is
    // neither the pre-write state (['r-docs','r-site']) NOR what the write
    // above persisted (['r-site']) — the case a tail retired only on an
    // exact match against its own result cannot distinguish from "hasn't
    // caught up yet", pinning it forever.
    await act(async () => {
      seedThread({ secondaryRootIds: ['r-alpha-db'] });
    });
    await flush();
    // The next write must derive from the externally-changed live set, not
    // revert it back toward the pinned tail.
    await act(async () => {
      result.current.onRemoveSecondary('r-alpha-db');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: [],
    });
  });

  // v3 of the three-case matrix above. PR #2685 review, item 2 (claude[bot]):
  // CONFIRMED EMPIRICALLY against the prior (v3-of-the-mechanism, coarse
  // single-scalar) fix — an identity bump on an UNRELATED field
  // (primaryRootId, via seedThread below) retired the tail while
  // secondaryRootIds itself was still the PRE-write value, so the next write
  // derived from a stale live ref and resurrected r-docs instead of
  // persisting []. Fixed by per-dimension revision tracking (BST-1400 item 2
  // v4): the tail now only retires once EVERY field the write touched has
  // moved, so an unrelated-field bump alone cannot spring it.
  it("does not retire the tail on an UNRELATED identity bump before the ref absorbs this write's OWN result", async () => {
    vi.useFakeTimers();
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs', 'r-site'],
    });
    await flush();
    // Same persist-only forwarder as the sibling tests above: this write's
    // OWN change to secondaryRootIds never reaches threadFoldersRef on its
    // own for the rest of this test.
    await act(async () => {
      useAssistantThreadStore.setState({
        updateThreadMetadata: async (
          repository: AssistantThreadRepository,
          _resourceId: string,
          threadId: string,
          metadata: AssistantThreadMetadata
        ) => {
          await repository.updateThreadMetadata(threadId, metadata);
        },
      });
    });
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: ['r-site'],
    });

    // An UNRELATED field changes and commits — primaryRootId (via
    // operatingRootId), NOT secondaryRootIds. secondaryRootIds in this
    // seed is deliberately still the PRE-write value (['r-docs',
    // 'r-site']) — nothing has touched that field; only primaryRootId
    // moved.
    await act(async () => {
      seedThread({
        operatingRootDisplayName: 'site',
        operatingRootId: 'r-site',
        operatingRootPath: '/ws/site',
        secondaryRootIds: ['r-docs', 'r-site'],
      });
    });
    await flush();

    // If the tail incorrectly retired on the unrelated bump, this derives
    // from the STALE live ref (['r-docs', 'r-site']) and would persist
    // ['r-docs'] here — resurrecting r-docs. If the tail correctly held
    // (secondaryRootIds itself never caught up), this derives from the
    // tail (['r-site']) and persists [].
    await act(async () => {
      result.current.onRemoveSecondary('r-site');
    });
    await flush();
    // NOTE: this assertion is the empirical probe, not a pre-judged
    // "correct" outcome — see the coordinator dispatch for BST-1400 for
    // what the result determines.
    expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
      secondaryRootIds: [],
    });
  });

  it('chains two Make primary clicks so the second demotes the first, dropping and duplicating nothing', async () => {
    vi.useFakeTimers();
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs', 'r-site'],
    });
    await flush();
    expect(result.current.secondaryRoots).toHaveLength(2);
    // The production window, made deterministic: the first write PERSISTS, but
    // its store update has not reached the render (and therefore the folder
    // ref) by the time the queued second write derives.
    await act(async () => {
      useAssistantThreadStore.setState({
        updateThreadMetadata: async (
          repository: AssistantThreadRepository,
          _resourceId: string,
          threadId: string,
          metadata: AssistantThreadMetadata
        ) => {
          await repository.updateThreadMetadata(threadId, metadata);
        },
      });
    });
    // Both clicks land inside ONE write round-trip: the second derives from
    // what the first persisted — ids AND the primary it just installed.
    await act(async () => {
      result.current.onMakePrimary('r-docs');
      result.current.onMakePrimary('r-site');
    });
    await flush();
    expect(updateThreadMetadata).toHaveBeenNthCalledWith(1, THREAD_ID, {
      operatingRootDisplayName: 'docs',
      operatingRootId: 'r-docs',
      operatingRootPath: '/ws/docs',
      secondaryRootIds: ['r-site', 'r-main-db'],
    });
    expect(updateThreadMetadata).toHaveBeenNthCalledWith(2, THREAD_ID, {
      operatingRootDisplayName: 'site',
      operatingRootId: 'r-site',
      operatingRootPath: '/ws/site',
      secondaryRootIds: ['r-main-db', 'r-docs'],
    });
    // Each Make primary is still exactly one write.
    expect(updateThreadMetadata).toHaveBeenCalledTimes(2);
  });
});
