import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { WorkspaceBarBranchMenu } from '@brainstrike/assistant-ui';
import type { ActionOutcome } from '@brainstrike/context-actions';
import type { DbHandle } from '@brainstrike/db/react';
import { revealLabel } from '@brainstrike/file-explorer-ui/context-actions';
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
function openLiveRootGate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  liveRootGate = { promise, release };
  return liveRootGate;
}

const isSecondaryLookup = (sql: unknown) => typeof sql === 'string' && sql.includes('= ANY');

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
const updateThreadMetadata = vi.fn(async () => {});
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
    ...{ adopt: vi.fn(), checkoutStatus: vi.fn() }, // no test here asserts on these
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

describe('useWorkspaceBar', () => {
  it('wires worktree create, branch escape, and local handoff to their distinct owners', async () => {
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
    const { result } = await setup();
    await waitFor(() => expect(result.current.mode?.createDisabledReason).toBeNull());

    await act(async () => {
      await result.current.mode?.onCreate({
        baseRef: 'main',
        branch: { name: 'bs/bright-fox' },
        name: 'bright-fox',
      });
    });

    expect(worktreeCreateSpy).toHaveBeenCalledTimes(1);
    expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
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
    expect(worktreeArchiveSpy).not.toHaveBeenCalled();
    expect(fs.addRootDirectory).not.toHaveBeenCalled();

    const branchArgs = branchSwitcherSpy.mock.calls.at(-1)?.[0];
    expect(branchArgs?.onSwitchInNewWorktree).toEqual(expect.any(Function));
    worktreeCreateSpy.mockClear();
    act(() => {
      branchArgs?.onSwitchInNewWorktree?.('feature/alpha');
    });
    await waitFor(() => expect(worktreeCreateSpy).toHaveBeenCalledTimes(1));
    expect(worktreeCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRef: 'feature/alpha',
        branch: { detached: true },
        name: 'feature-alpha',
      })
    );
    expect(worktreeArchiveSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(result.current.mode?.onHandOffToLocal).toBeDefined());
    const metadataWriteCount = updateThreadMetadata.mock.calls.length;
    act(() => {
      result.current.mode?.onHandOffToLocal?.();
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        checkoutMode: 'local',
        operatingRootDisplayName: 'brainstrike',
        operatingRootId: 'r-main-db',
        operatingRootPath: '/ws/brainstrike',
        secondaryRootIds: [],
      })
    );
    expect(updateThreadMetadata).toHaveBeenCalledTimes(metadataWriteCount + 1);
    expect(worktreeArchiveSpy).not.toHaveBeenCalled();
  });

  it('omits `forge` entirely when there is no forge bridge', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.primaryRoot).toBeDefined());
    expect(result.current.forge).toBeUndefined();
  });

  it("persists the selected thread's forge watch toggle", async () => {
    forgePrSpy.mockReturnValue({
      diagnostic: null,
      refresh: vi.fn(),
      status: {
        kind: 'pr',
        observedAt: '2026-08-24T00:00:00.000Z',
        pullRequest: {
          checks: [],
          checksRollup: 'none',
          headSha: 'sha',
          isDraft: false,
          number: 7,
          reviewDecision: null,
          state: 'open',
          title: 'PR',
          url: 'https://example.test/pull/7',
        },
      },
    });
    const { result } = await setup();
    await waitFor(() => expect(result.current.forge).toBeDefined());
    expect(result.current.forge?.watched).toBe(true);
    const onWatchChange = result.current.forge?.onWatchChange;
    if (!onWatchChange) {
      throw new Error('a thread is selected, so the Watch toggle must be present');
    }
    await act(async () => {
      onWatchChange(false);
    });

    expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, { forgePrWatch: false });
  });

  it('exposes the primary root, checkout, and recents minus the current roots', async () => {
    const { result } = await setup();
    await waitFor(() =>
      expect(result.current.primaryRoot).toEqual({
        displayName: 'brainstrike',
        path: '/ws/brainstrike',
        rootId: 'r-main-db',
      })
    );
    expect(result.current.checkout).toEqual({
      ahead: 0,
      behind: 0,
      branch: 'main',
      dirty: false,
    });
    expect(branchSwitcherSpy).toHaveBeenCalledWith({
      checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
      dbRootId: 'r-main-db',
    });
    expect(result.current.branchMenu).toBe(branchMenu);
    await waitFor(() =>
      expect(result.current.recentRoots).toEqual([{ displayName: 'alpha', path: '/ws/alpha' }])
    );
    expect(result.current.onAddRecent).toBeDefined();
  });

  it('resolves the unbound primary by PATH in the durable roots table, never the adapter id', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.primaryRoot?.rootId).toBe('r-main-db'));
    // The bar itself is DB-space: the rendered chip carries the roots row id.
    expect(result.current.primaryRoot?.rootId).toBe('r-main-db');
  });

  it('asks for the checkout with BOTH ids: the DB row for git, the adapter id for refresh mapping', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.primaryRoot?.rootId).toBe('r-main-db'));
    // `window.git.status` speaks the DB space; the FILE_EXPLORER_REFRESH_EVENT
    // registration speaks the ADAPTER space. Collapsing them silently strands
    // the dirty dot for every legacy path-matched root.
    expect(checkoutSpy).toHaveBeenCalledWith({
      adapterRootId: 'adapter-main',
      dbRootId: 'r-main-db',
      path: '/ws/brainstrike',
    });
  });

  it('registers no working-tree scope for a primary that is not mounted in this workspace', async () => {
    // The thread is bound to a folder that is NOT among the mounted roots, so
    // no descriptor supplies an adapter id. Registering the DB id instead would
    // silently match nothing while looking correct.
    const { result } = await setup({
      operatingRootDisplayName: 'site',
      operatingRootId: 'r-site',
      operatingRootPath: '/ws/site',
    });
    await waitFor(() => expect(result.current.primaryRoot?.rootId).toBe('r-site'));
    expect(checkoutSpy).toHaveBeenCalledWith({
      adapterRootId: null,
      dbRootId: 'r-site',
      path: '/ws/site',
    });
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('not mounted'),
      expect.objectContaining({ path: '/ws/site' })
    );
  });

  it('warns and shows no primary when the MAIN root has no live roots row', async () => {
    vi.useFakeTimers();
    liveRootMisses.set('/ws/brainstrike', Number.POSITIVE_INFINITY);
    const { result } = await setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.primaryRoot).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('no unique live roots row'),
      expect.objectContaining({ path: '/ws/brainstrike' })
    );
    // Never an invented id — the adapter id must not stand in for the DB row.
    expect(checkoutSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ dbRootId: 'adapter-main' })
    );
    expect(checkoutSpy).toHaveBeenCalledWith(null);
  });

  it('re-resolves the MAIN root after a changes invalidation instead of staying blank forever', async () => {
    vi.useFakeTimers();
    liveRootMisses.set('/ws/brainstrike', Number.POSITIVE_INFINITY);
    const { result } = await setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.primaryRoot).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    // Reconciliation has since written the row and announced it.
    liveRootMisses.set('/ws/brainstrike', 0);
    await act(async () => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/ws/brainstrike/.git',
        repositoryRoot: '/ws/brainstrike',
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.primaryRoot?.rootId).toBe('r-main-db');
  });

  it('resolves secondaryRootIds to display rows from the roots table', async () => {
    const { result } = await setup({ secondaryRootIds: ['r-docs'] });
    await waitFor(() =>
      expect(result.current.secondaryRoots).toEqual([
        { displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' },
      ])
    );
  });

  it('drops a secondary id with no roots row instead of rendering a placeholder', async () => {
    const { result } = await setup({ secondaryRootIds: ['r-docs', 'r-ghost'] });
    await waitFor(() =>
      expect(result.current.secondaryRoots).toEqual([
        { displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' },
      ])
    );
    expect(loggerMock.warn).toHaveBeenCalledWith('secondary root id has no roots row', {
      id: 'r-ghost',
    });
  });

  it('does not re-query the roots table when a thread refresh yields the same secondary ids', async () => {
    const { result } = await setup({ secondaryRootIds: ['r-docs'] });
    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(1));
    const before = query.mock.calls.filter((call) => isSecondaryLookup(call[0])).length;
    // A fresh thread object carrying an EQUAL id list — identity churn only.
    await act(async () => {
      seedThread({ secondaryRootIds: ['r-docs'] });
    });
    await act(async () => {});
    expect(query.mock.calls.filter((call) => isSecondaryLookup(call[0])).length).toBe(before);
  });

  it('Add folder adds globally and records the new root as a thread secondary', async () => {
    const { result } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        secondaryRootIds: ['r-docs'],
      })
    );
  });

  it('refreshes the recents ledger after a same-session grant, without a remount', async () => {
    const { result } = await setup();
    await waitFor(() =>
      expect(result.current.recentRoots).toEqual([{ displayName: 'alpha', path: '/ws/alpha' }])
    );

    // Models main appending the just-granted folder to `recentRootsList` the
    // instant `addRoot()` resolves — the ledger the bar's snapshot must catch
    // up to without a remount/reload.
    fs.listRecentRoots.mockResolvedValueOnce([
      { displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' },
      { displayName: 'brainstrike', lastGrantedAt: 2, path: '/ws/brainstrike' },
      { displayName: 'docs', lastGrantedAt: 3, path: '/ws/docs' },
    ]);

    await act(async () => {
      result.current.onAddFolder();
    });
    await waitFor(() => expect(updateThreadMetadata).toHaveBeenCalled());

    await waitFor(() =>
      expect(result.current.recentRoots).toEqual(
        expect.arrayContaining([{ displayName: 'docs', path: '/ws/docs' }])
      )
    );
  });

  it('waits for roots reconciliation before attaching a just-added folder', async () => {
    vi.useFakeTimers();
    // The registration effect has not written the row yet when the add resolves.
    liveRootMisses.set('/ws/docs', 3);
    const { result } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
      secondaryRootIds: ['r-docs'],
    });
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('surfaces a folder that never reconciles instead of silently dropping it', async () => {
    vi.useFakeTimers();
    liveRootMisses.set('/ws/docs', Number.POSITIVE_INFINITY);
    const { result } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(toastSpy).toHaveBeenCalledWith({
      description: expect.stringContaining('docs'),
      title: 'Folder added, but not attached to this thread',
      variant: 'destructive',
    });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it('abandons an in-flight folder attachment when the selected thread changes', async () => {
    vi.useFakeTimers();
    liveRootMisses.set('/ws/docs', 3);
    const { rerender, result } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    await act(async () => {
      rerender({ selectedMemoryThreadId: 'thread-2' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // The write captured thread-1's folder set; landing it now would replace
    // thread-2's folders with thread-1's.
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('abandons an in-flight folder attachment when the thread changes during the final lookup', async () => {
    const { rerender, result } = await setup();
    const gate = openLiveRootGate();
    await act(async () => {
      result.current.onAddFolder();
    });
    await act(async () => {
      rerender({ selectedMemoryThreadId: 'thread-2' });
    });
    await act(async () => {
      gate.release();
    });
    await act(async () => {});
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('abandons an in-flight folder attachment when the hook unmounts', async () => {
    vi.useFakeTimers();
    liveRootMisses.set('/ws/docs', 3);
    const { result, unmount } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('serializes two rapid Add folder writes so neither id is dropped', async () => {
    const { result } = await setup();
    fs.addRootDirectory
      .mockResolvedValueOnce({
        kind: 'directory',
        name: 'docs',
        path: '/ws/docs',
        platform: 'electron',
        rootId: 'adapter-docs',
      })
      .mockResolvedValueOnce({
        kind: 'directory',
        name: 'site',
        path: '/ws/site',
        platform: 'electron',
        rootId: 'adapter-site',
      });
    await act(async () => {
      result.current.onAddFolder();
      result.current.onAddFolder();
    });
    await act(async () => {});
    // Both lookups settle in the same tick: an unserialized second write would
    // read the pre-click set and persist ['r-site'] alone.
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenLastCalledWith(THREAD_ID, {
        secondaryRootIds: ['r-docs', 'r-site'],
      })
    );
  });

  it('does not rewrite the thread when the added folder is already the primary', async () => {
    const { result } = await setup({
      operatingRootDisplayName: 'docs',
      operatingRootId: 'r-docs',
      operatingRootPath: '/ws/docs',
    });
    await act(async () => {
      result.current.onAddFolder();
    });
    await act(async () => {});
    expect(fs.addRootDirectory).toHaveBeenCalled();
    expect(updateThreadMetadata).not.toHaveBeenCalled();
  });

  it('does not rewrite the thread when the added folder is already a secondary', async () => {
    const { result } = await setup({ secondaryRootIds: ['r-docs'] });
    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(1));
    await act(async () => {
      result.current.onAddFolder();
    });
    await act(async () => {});
    expect(updateThreadMetadata).not.toHaveBeenCalled();
  });

  it('Make primary re-binds the thread (not global MAIN) and demotes the old primary to a secondary', async () => {
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs'],
    });
    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(1));
    await act(async () => {
      result.current.onMakePrimary('r-docs');
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        operatingRootDisplayName: 'docs',
        operatingRootId: 'r-docs',
        operatingRootPath: '/ws/docs',
        secondaryRootIds: ['r-main-db'],
      })
    );
    // ONE write: the store must never show the new primary as a secondary too.
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
  });

  it('withholds the checkout while the primary root is absent', async () => {
    vi.useFakeTimers();
    // The primary never resolves, so `primaryRoot` stays undefined — but the
    // checkout hook is mocked to always answer. The branch chip must not
    // render a branch with no folder beside it.
    liveRootMisses.set('/ws/brainstrike', Number.POSITIVE_INFINITY);
    const { result } = await setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.primaryRoot).toBeUndefined();
    expect(result.current.checkout).toBeUndefined();
    expect(result.current.branchMenu).toBeUndefined();
  });

  it('supplies the reveal action with the platform label, never a hardcoded OS name', async () => {
    const { result } = await setup();
    expect(result.current.reveal?.label).toBe(revealLabel());
    result.current.reveal?.onReveal('/ws/brainstrike');
    expect(showItemInFolder).toHaveBeenCalledWith('/ws/brainstrike');
  });

  it('rejects and logs a folder write with no active thread, instead of silently skipping it', async () => {
    const { rerender, result } = await setup({ secondaryRootIds: ['r-docs'] });
    rerender({ selectedMemoryThreadId: undefined });

    // The write-queue's promise is never exposed publicly, so its REJECTION
    // (not the silent resolve the thread-switch branch above it uses) is
    // captured through the toast it produces.
    const writeOutcome = new Promise<void>((_resolve, reject) => {
      toastSpy.mockImplementationOnce(({ description }: { description: string }) =>
        reject(new Error(description))
      );
    });
    writeOutcome.catch(() => undefined);
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    // A caller bug, not the ordinary thread-switch skip — must be loud, must not write.
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Cannot update thread folders without an active thread'
    );
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    await expect(writeOutcome).rejects.toThrow(
      'Cannot update thread folders without an active thread.'
    );
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'Cannot update thread folders without an active thread.',
      title: 'Remove folder failed',
      variant: 'destructive',
    });
  });

  it('offers no recents and no re-mount affordance on web (capabilities absent)', async () => {
    currentFs = webFs;
    const { result } = await setup();
    expect(result.current.recentRoots).toEqual([]);
    expect(result.current.onAddRecent).toBeUndefined();
    expect(fs.listRecentRoots).not.toHaveBeenCalled();
  });

  it('Remove secondary drops only that id', async () => {
    const { result } = await setup({ secondaryRootIds: ['r-docs', 'r-site'] });
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
      secondaryRootIds: ['r-site'],
    });
  });

  // Write-tail chaining/derivation tests (a newly selected thread deriving
  // from its OWN folders, deriving from the live set post-drain, chaining two
  // Make primary clicks) live in use-workspace-bar-write-tail.test.tsx —
  // moved there when this file crossed Biome's 1000-line cap; that file
  // already covers the same shared write-tail queue theme.
});
