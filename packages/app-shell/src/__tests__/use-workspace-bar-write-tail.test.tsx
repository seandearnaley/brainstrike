/**
 * useWorkspaceBar's shared metadata-write-tail chaining — making a secondary
 * primary and immediately making the just-demoted root primary again, plus
 * creating a worktree and handing the thread back to local while that first
 * write is still in flight. Both cases pin the `updateThreadMetadata`
 * serialization queue so the second action derives from the first write.
 *
 * Split out of `use-workspace-bar.test.tsx`, which crossed Biome's 1000-line
 * cap. The shared fixtures below are duplicated rather than imported: each
 * Vitest file needs its OWN `vi.mock`/`vi.hoisted` registrations (mocking is
 * scoped per test file, so a hoisted spy cannot be shared by reference across
 * files), and everything else here participates in that per-file mock setup
 * (`beforeEach` resets it, `setup()` renders through it) closely enough that
 * splitting it out would just relocate the same coupling rather than remove
 * it. Helpers and fixtures unused on this side (`openLiveRootGate`,
 * `isSecondaryLookup`, `OTHER_THREAD_ID`, `revealLabel`) were dropped rather
 * than carried over dead.
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
  listRecentRoots: vi.fn(async () => [
    { displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' },
    { displayName: 'brainstrike', lastGrantedAt: 2, path: '/ws/brainstrike' },
  ]),
};
// Web omits the desktop-only capabilities rather than stubbing them.
const webFs: Pick<typeof fs, 'addRootDirectory'> &
  Partial<Pick<typeof fs, 'addRootDirectoryByPath' | 'listRecentRoots'>> = {
  addRootDirectory: fs.addRootDirectory,
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
      ahead: 0,
      behind: 0,
      branch: 'main',
      dirty: false,
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
    archive: worktreeArchiveSpy,
    create: worktreeCreateSpy,
    createBranchHere: vi.fn(),
    createContext: vi.fn(async () => ({
      ok: true as const,
      value: {
        managedParentPath: '/managed/brainstrike-slug',
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
});
