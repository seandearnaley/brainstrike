import type {
  AssistantThreadMetadata,
  AssistantThreadRepository,
} from '@brainstrike/assistant-data';
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

const { branchSwitcherSpy, checkoutSpy, clipboardWriteText, forgePrSpy, loggerMock, toastSpy } =
  vi.hoisted(() => ({
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

/** Flush the microtask chain a queued metadata write runs on. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function copyPathOf(props: { readonly onCopyPath?: ((path: string) => void) | undefined }) {
  const { onCopyPath } = props;
  if (!onCopyPath) {
    throw new Error('the workspace bar must always expose onCopyPath');
  }
  return onCopyPath;
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
  vi.useRealTimers();
});

describe('useWorkspaceBar', () => {
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

    await act(async () => {
      result.current.forge?.onWatchChange(false);
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
  });

  it('supplies the reveal action with the platform label, never a hardcoded OS name', async () => {
    const { result } = await setup();
    expect(result.current.reveal?.label).toBe(revealLabel());
    result.current.reveal?.onReveal('/ws/brainstrike');
    expect(showItemInFolder).toHaveBeenCalledWith('/ws/brainstrike');
  });

  it('logs instead of silently skipping a folder write with no active thread', async () => {
    const { rerender, result } = await setup({ secondaryRootIds: ['r-docs'] });
    rerender({ selectedMemoryThreadId: undefined });

    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });

    // A write fired with nothing selected is a caller bug, not the ordinary
    // thread-switch skip — it must be loud, and it must not write.
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Cannot update thread folders without an active thread'
    );
    expect(updateThreadMetadata).not.toHaveBeenCalled();
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

  it('surfaces a failed Copy path instead of swallowing it', async () => {
    clipboardWriteText.mockResolvedValue({
      error: 'Desktop clipboard bridge rejected the write',
      ok: false,
    } satisfies ActionOutcome);
    const { result } = await setup();
    await act(async () => {
      copyPathOf(result.current)('/ws/docs');
    });
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'Desktop clipboard bridge rejected the write',
      title: 'Copy path failed',
      variant: 'destructive',
    });
  });

  it('surfaces a failed Add folder with the platform message, never a bare log', async () => {
    fs.addRootDirectory.mockRejectedValueOnce(new Error('The folder picker was unavailable.'));
    const { result } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    expect(loggerMock.error).toHaveBeenCalledWith('Add folder failed', expect.anything());
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'The folder picker was unavailable.',
      title: 'Add folder failed',
      variant: 'destructive',
    });
  });

  it('surfaces a recent folder that can no longer be opened, quoting the main-process reason', async () => {
    // The exact message main returns when a path is no longer in the grant
    // ledger; a generic "something went wrong" would hide the remedy.
    fs.addRootDirectoryByPath.mockRejectedValueOnce(
      new Error('Folder was never granted in this app; use Add Folder to grant it.')
    );
    const { result } = await setup();
    await act(async () => {
      result.current.onAddRecent?.('/ws/alpha');
    });
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Recent folder could not be re-mounted',
      expect.objectContaining({ path: '/ws/alpha' })
    );
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'Folder was never granted in this app; use Add Folder to grant it.',
      title: "Couldn't open recent folder",
      variant: 'destructive',
    });
  });

  it("strips Electron's remote-method wrapper so the toast shows the actionable remedy", async () => {
    // What the renderer ACTUALLY receives: `ipcRenderer.invoke` re-wraps a
    // main-process throw, so the message main wrote arrives buried behind
    // `Error invoking remote method '<channel>': Error: `. Showing that
    // verbatim buries the remedy the user needs behind IPC plumbing.
    fs.addRootDirectoryByPath.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'fs:addRootByPath': Error: Folder was never granted in this app; use Add Folder to grant it."
      )
    );
    const { result } = await setup();
    await act(async () => {
      result.current.onAddRecent?.('/ws/alpha');
    });
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'Folder was never granted in this app; use Add Folder to grant it.',
      title: "Couldn't open recent folder",
      variant: 'destructive',
    });
  });

  it('surfaces a failed Make primary and a failed Remove folder', async () => {
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs'],
    });
    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(1));

    updateThreadMetadata.mockRejectedValueOnce(new Error('metadata write rejected'));
    await act(async () => {
      result.current.onMakePrimary('r-docs');
    });
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'metadata write rejected',
        title: 'Make primary failed',
        variant: 'destructive',
      })
    );

    updateThreadMetadata.mockRejectedValueOnce(new Error('metadata write rejected'));
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'metadata write rejected',
        title: 'Remove folder failed',
        variant: 'destructive',
      })
    );
  });

  it('refuses a folder write while the selected thread metadata is still loading', async () => {
    // The thread is selected but its row has not arrived in the store yet, so
    // `secondaryRootIds` reads as EMPTY — writing now would persist an empty
    // folder set over whatever the thread actually has.
    seedThreads([{ id: OTHER_THREAD_ID, metadata: {} }], THREAD_ID);
    const { result } = renderHook(() =>
      useWorkspaceBar({
        assistantThreadRepository,
        currentMainRoot,
        database,
        memoryResourceId: RESOURCE_ID,
        rootDescriptors,
        selectedMemoryThreadId: THREAD_ID,
      })
    );
    await act(async () => {});

    await act(async () => {
      result.current.onAddFolder();
    });
    await act(async () => {});

    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Cannot update thread folders before the selected thread metadata is loaded'
    );
    expect(toastSpy).toHaveBeenCalledWith({
      description: expect.stringContaining('moment'),
      title: 'Thread is still loading',
      variant: 'destructive',
    });
  });

  it('says nothing when Copy path succeeds', async () => {
    const { result } = await setup();
    await act(async () => {
      copyPathOf(result.current)('/ws/docs');
    });
    expect(clipboardWriteText).toHaveBeenCalledWith('/ws/docs');
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
