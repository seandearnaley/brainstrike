/**
 * useWorkspaceBar's Add-folder flow: the global add + thread-secondary
 * attach, Recents refresh across the three ways a folder can reappear after
 * a same-session disconnect (Workspace Bar grant, Explorer grant, restore
 * backfill), stale-response ordering, the await-root-registration seam
 * (including its epoch fix for a re-added path) and its no-polling
 * guarantee, abandonment on thread-switch/unmount/final-lookup-race, rapid
 * double-click serialization, and the two "already attached" no-op guards.
 *
 * Split out of `use-workspace-bar.test.tsx` (BST-1400 full-branch review
 * fold-in), which crossed Biome's 1000-line cap a third time — the Add-folder
 * cluster above is this file's own coherent theme, the same reasoning that
 * moved the write-tail-chaining and failure-surfacing clusters into their own
 * files earlier. The shared fixtures below are duplicated rather than
 * imported: each Vitest file needs its OWN `vi.mock`/`vi.hoisted`
 * registrations (mocking is scoped per test file, so a hoisted spy cannot be
 * shared by reference across files), and everything else here participates in
 * that per-file mock setup (`beforeEach` resets it, `setup()` renders through
 * it) closely enough that splitting it out would just relocate the same
 * coupling rather than remove it. Helpers and fixtures unused on this side
 * (`isSecondaryLookup`, `revealLabel`) were dropped rather than carried over
 * dead.
 */
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { WorkspaceBarBranchMenu } from '@brainstrike/assistant-ui';
import type { ActionOutcome } from '@brainstrike/context-actions';
import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useWorkspaceBar } from '../hooks/use-workspace-bar';
import {
  notifyRootRegistered,
  resetRootRegistrationEventsForTests,
} from '../roots/root-registration-events';

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
  recentRootsRevision: 0,
  registerRestoredHandles: vi.fn(async (_handles: readonly unknown[]) => undefined),
};
// Web omits the desktop-only capabilities rather than stubbing them.
const webFs: Pick<
  typeof fs,
  'addRootDirectory' | 'isFileSystemAccessSupported' | 'recentRootsRevision'
> &
  Partial<Pick<typeof fs, 'addRootDirectoryByPath' | 'listRecentRoots'>> = {
  addRootDirectory: fs.addRootDirectory,
  isFileSystemAccessSupported: fs.isFileSystemAccessSupported,
  recentRootsRevision: 0,
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
  // Default return value is installed in `beforeEach` (via mockReturnValue,
  // reinstalled after mockReset every test) rather than here, since one test
  // below overrides it with mockReturnValue for the whole test body.
  checkoutSpy: vi.fn(),
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

const query = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes('FROM roots') && sql.includes('= ANY')) {
    const ids = (params?.[0] ?? []) as readonly string[];
    return {
      rows: ids.flatMap((id) => {
        const row = ROOT_ROW_BY_ID[id];
        return row ? [{ displayName: row.displayName, id, path: row.path, status: 'live' }] : [];
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

interface BarProps {
  readonly selectedMemoryThreadId: string | undefined;
}

async function setup(
  metadata: Record<string, unknown> = {},
  rootDescriptorsOverride: typeof rootDescriptors = rootDescriptors
) {
  seedThread(metadata);
  const rendered = renderHook(
    (props: BarProps) =>
      useWorkspaceBar({
        assistantThreadRepository,
        currentMainRoot,
        database,
        memoryResourceId: RESOURCE_ID,
        rootDescriptors: rootDescriptorsOverride,
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
  resetRootRegistrationEventsForTests();
  useChangesLiveRefreshStore.getState().reset();
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue({ ok: true } satisfies ActionOutcome);
  branchSwitcherSpy.mockReset();
  branchSwitcherSpy.mockReturnValue(branchMenu);
  // reset (not clear): one test overrides the return value with
  // mockReturnValue, which mockClear alone would leak into later tests.
  checkoutSpy.mockReset();
  checkoutSpy.mockReturnValue({
    checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
    settled: true,
  });
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
  fs.addRootDirectory.mockReset();
  fs.addRootDirectory.mockImplementation(async () => {
    fs.recentRootsRevision += 1;
    return {
      kind: 'directory',
      name: 'docs',
      path: '/ws/docs',
      platform: 'electron',
      rootId: 'adapter-docs',
    };
  });
  fs.addRootDirectoryByPath.mockReset();
  fs.addRootDirectoryByPath.mockImplementation(async (path: string) => {
    fs.recentRootsRevision += 1;
    return {
      kind: 'directory',
      name: 'alpha',
      path,
      platform: 'electron',
      rootId: 'adapter-alpha',
    };
  });
  fs.listRecentRoots.mockReset();
  fs.listRecentRoots.mockResolvedValue([
    { displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' },
    { displayName: 'brainstrike', lastGrantedAt: 2, path: '/ws/brainstrike' },
  ]);
  fs.recentRootsRevision = 0;
  fs.registerRestoredHandles.mockReset();
  fs.registerRestoredHandles.mockImplementation(async () => {
    fs.recentRootsRevision += 1;
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, 'platform');
  Reflect.deleteProperty(window, 'worktrees');
  vi.useRealTimers();
});

describe('useWorkspaceBar — Add folder', () => {
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

  it('shows a Workspace Bar grant after disconnect in the same session', async () => {
    const { rerender, result } = await setup();
    fs.listRecentRoots.mockResolvedValueOnce([
      { displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' },
      { displayName: 'brainstrike', lastGrantedAt: 2, path: '/ws/brainstrike' },
      { displayName: 'docs', lastGrantedAt: 3, path: '/ws/docs' },
    ]);

    await act(async () => {
      result.current.onAddFolder();
    });
    await waitFor(() => expect(fs.addRootDirectory).toHaveBeenCalledTimes(1));
    rerender({ selectedMemoryThreadId: THREAD_ID });

    await waitFor(() =>
      expect(result.current.recentRoots).toEqual(
        expect.arrayContaining([{ displayName: 'docs', path: '/ws/docs' }])
      )
    );
  });

  it('shows an Explorer-granted folder after disconnect in the same session', async () => {
    const { rerender, result } = await setup();
    await waitFor(() =>
      expect(result.current.recentRoots).toEqual([{ displayName: 'alpha', path: '/ws/alpha' }])
    );

    // Explorer Add Folder mutates the shared file-system source. The folder is
    // already disconnected (absent from rootDescriptors) when the bar refreshes.
    fs.listRecentRoots.mockResolvedValueOnce([
      { displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' },
      { displayName: 'brainstrike', lastGrantedAt: 2, path: '/ws/brainstrike' },
      { displayName: 'docs', lastGrantedAt: 3, path: '/ws/docs' },
    ]);
    fs.recentRootsRevision += 1;
    rerender({ selectedMemoryThreadId: THREAD_ID });

    await waitFor(() =>
      expect(result.current.recentRoots).toEqual(
        expect.arrayContaining([{ displayName: 'docs', path: '/ws/docs' }])
      )
    );
    expect(fs.addRootDirectory).not.toHaveBeenCalled();
  });

  it('shows a restore-backfilled folder after disconnect in the same session', async () => {
    const { rerender, result } = await setup();
    fs.listRecentRoots.mockResolvedValueOnce([
      { displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' },
      { displayName: 'brainstrike', lastGrantedAt: 2, path: '/ws/brainstrike' },
      { displayName: 'restored', lastGrantedAt: 3, path: '/ws/restored' },
    ]);

    await act(async () => {
      await fs.registerRestoredHandles([
        {
          kind: 'directory',
          name: 'restored',
          path: '/ws/restored',
          platform: 'electron',
          rootId: 'adapter-restored',
        },
      ]);
    });
    rerender({ selectedMemoryThreadId: THREAD_ID });

    await waitFor(() =>
      expect(result.current.recentRoots).toEqual(
        expect.arrayContaining([{ displayName: 'restored', path: '/ws/restored' }])
      )
    );
  });

  it('ignores an older overlapping recents response after a newer refresh wins', async () => {
    let resolveOlder:
      | ((entries: Awaited<ReturnType<typeof fs.listRecentRoots>>) => void)
      | undefined;
    fs.listRecentRoots.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        })
    );
    const { rerender, result } = await setup();

    fs.listRecentRoots.mockResolvedValueOnce([
      { displayName: 'newer', lastGrantedAt: 4, path: '/ws/newer' },
    ]);
    fs.recentRootsRevision += 1;
    rerender({ selectedMemoryThreadId: THREAD_ID });
    await waitFor(() =>
      expect(result.current.recentRoots).toEqual([{ displayName: 'newer', path: '/ws/newer' }])
    );

    await act(async () => {
      resolveOlder?.([{ displayName: 'older', lastGrantedAt: 1, path: '/ws/older' }]);
    });
    expect(result.current.recentRoots).toEqual([{ displayName: 'newer', path: '/ws/newer' }]);
  });

  it('waits for roots reconciliation before attaching a just-added folder', async () => {
    // The registration effect has not written the row yet when the add resolves.
    liveRootMisses.set('/ws/docs', 1);
    const { result } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    // Reconciliation writes the row and announces it — no more polling for it.
    await act(async () => {
      notifyRootRegistered(['/ws/docs']);
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        secondaryRootIds: ['r-docs'],
      })
    );
    expect(toastSpy).not.toHaveBeenCalled();
  });

  // BST-1400 review fix: a PRIOR registration of the same path (the exact
  // remove-then-re-add shape `use-workspace-bar.ts`'s docblock covers — a
  // re-add mints a fresh adapter id, so reconciliation genuinely notifies
  // TWICE for `/ws/docs`) must not let a membership-style "was this path
  // EVER registered?" check resolve the wait against the STALE first
  // registration. Only the SECOND notifyRootRegistered may satisfy it.
  it('waits for the SECOND registration of a re-added path — not the stale first one', async () => {
    // Models an earlier registration of this exact path this session (e.g. a
    // prior Add folder, or the boot batch), before this test's Add folder
    // click even happens.
    notifyRootRegistered(['/ws/docs']);

    liveRootMisses.set('/ws/docs', 1);
    const { result } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    // A membership-set bug would have resolved instantly off the FIRST
    // (stale) registration above and already landed this write by now.
    expect(updateThreadMetadata).not.toHaveBeenCalled();

    // The re-add's own (SECOND) registration.
    await act(async () => {
      notifyRootRegistered(['/ws/docs']);
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        secondaryRootIds: ['r-docs'],
      })
    );
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('does not poll the database while awaiting root registration (no interval churn)', async () => {
    vi.useFakeTimers();
    // Never notified in this test — models reconciliation taking a while.
    liveRootMisses.set('/ws/docs', Number.POSITIVE_INFINITY);
    const { result } = await setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    // Scoped to /ws/docs specifically (PATH-specific, like the query mock
    // itself notes) — setup() also issues its OWN single-root lookup for the
    // MAIN root's path, which is unrelated to this Add-folder flow and must
    // not be counted here.
    const docsLookup = (call: unknown[]) =>
      typeof call[0] === 'string' &&
      call[0].includes('FROM roots') &&
      !call[0].includes('= ANY') &&
      (call[1] as unknown[] | undefined)?.[0] === '/ws/docs';
    const lookupsAfterAdd = query.mock.calls.filter(docsLookup).length;
    // Pins the "exactly one read before the wait" half of the design — without
    // this, a broken Add-folder flow that issued NO read at all would still
    // pass the post-window comparison below at a vacuous 0 === 0.
    expect(lookupsAfterAdd).toBe(1);
    await act(async () => {
      // The old 20x250ms retry loop would have issued ~16 more queries across
      // this window; the event-based wait issues none until notified or timed
      // out — there is no interval driving it.
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(query.mock.calls.filter(docsLookup).length).toBe(lookupsAfterAdd);
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
});
