/**
 * The Add-folder flow (global add/attach, Recents refresh, the
 * await-root-registration seam, abandonment, double-click serialization,
 * "already attached" no-ops) lives in `use-workspace-bar-add-folder.test.tsx`
 * — split out (BST-1400 full-branch review fold-in) once this file crossed
 * Biome's 1000-line cap a third time, the same reasoning that moved the
 * write-tail-chaining and failure-surfacing clusters into their own files.
 */
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
import { resetRootRegistrationEventsForTests } from '../roots/root-registration-events';

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
  // BST-1393 L2: useConnectFolder() (via useFolderDrop()) calls this unconditionally.
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
// Read by the shared `query` mock below; `openLiveRootGate` (the only setter)
// moved to use-workspace-bar-add-folder.test.tsx with its one caller — no
// test left in this file ever opens the gate, so it stays permanently null.
let liveRootGate: { promise: Promise<void>; release: () => void } | null = null;

const isSecondaryLookup = (sql: unknown) => typeof sql === 'string' && sql.includes('= ANY');

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

interface BarProps {
  // Optional: a `rerender` call omitting it keeps using the value `setup`
  // closed over (every caller except the collision test below). Present so a
  // test CAN pass a fresh reference across a rerender — the collision guard
  // is keyed on `[rootDescriptors]` identity, so re-passing the SAME object
  // reference would never re-run that effect at all, making a "warns only
  // once" assertion pass vacuously regardless of the guard's own logic.
  readonly rootDescriptors?: typeof rootDescriptors;
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
        rootDescriptors: props.rootDescriptors ?? rootDescriptorsOverride,
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

  // BST-1400: `checkoutState` is the deterministic e2e wait
  // (`data-checkout-state` on the bar) that replaces sampling for the branch
  // chip's absence.
  it('surfaces checkoutState as pending until useThreadCheckoutStatus settles, then resolved', async () => {
    // `mockReturnValue` (not `...Once`) so every render during the "waiting
    // for the primary to resolve" phase below keeps reporting pending — a
    // one-shot override would be consumed by an earlier render than the one
    // this test inspects.
    checkoutSpy.mockReturnValue({ checkout: undefined, settled: false });
    const { result } = await setup();
    await waitFor(() => expect(result.current.primaryRoot?.rootId).toBe('r-main-db'));
    expect(result.current.checkoutState).toBe('pending');

    checkoutSpy.mockReturnValue({
      checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
      settled: true,
    });
    await act(async () => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/ws/brainstrike/.git',
        repositoryRoot: '/ws/brainstrike',
      });
    });
    await waitFor(() => expect(result.current.checkoutState).toBe('resolved'));
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

  // BST-1400 item 13: two adapter root descriptors sharing a path (a genuine
  // duplicate mount, or a spelling divergence the adapter never normalized —
  // e.g. a macOS case variant) collapse to one in the derived path→adapterId
  // map. Whichever descriptor loses that collision never gets its
  // working-tree refresh registered, and until this fix nothing logged why.
  it('warns once per path on a collision, never for distinct paths', async () => {
    // TWO descriptors, DIFFERENT paths — not the default one-descriptor
    // fixture (BST-1400 item 13 review fold-in): an implementation keyed on
    // `Object.keys(rootDescriptors).length > 1` rather than genuine path
    // equality would pass a one-entry fixture unchanged, since there is only
    // one path to (not) collide with either way.
    const distinctDescriptors = {
      ...rootDescriptors,
      'adapter-other': { displayName: 'other', path: '/ws/other', rootId: 'adapter-other' },
    };
    const noCollision = await setup({}, distinctDescriptors);
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('share a path'),
      expect.anything()
    );
    noCollision.unmount();

    const dupeDescriptors = {
      ...rootDescriptors,
      'adapter-main-2': { displayName: 'brainstrike (2)', path: '/ws/brainstrike', rootId: '' },
    };
    const { rerender } = await setup({}, dupeDescriptors);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('share a path'),
      expect.objectContaining({
        adapterRootIds: expect.arrayContaining(['adapter-main', 'adapter-main-2']),
        path: '/ws/brainstrike',
      })
    );

    // A re-render with the SAME collision, but a FRESH object reference
    // (BST-1400 item 13 review fold-in), must not warn again. The guard's
    // effect is keyed on `[rootDescriptors]` identity — re-passing the SAME
    // reference (the bug in the original version of this test) never
    // re-runs the effect at all, so "does not warn again" would pass even
    // with the once-guard deleted. A fresh reference with the same
    // collision is the shape a live re-mount loop actually produces (the
    // store rebuilds the descriptors map via `Object.fromEntries(...)` on
    // every mount/unmount), which is exactly what the guard exists for.
    const warnCallsAfterMount = loggerMock.warn.mock.calls.length;
    await act(async () => {
      rerender({ rootDescriptors: { ...dupeDescriptors }, selectedMemoryThreadId: THREAD_ID });
    });
    expect(loggerMock.warn.mock.calls.length).toBe(warnCallsAfterMount);
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

  // BST-1990: the binding still names it and the host refuses runs until it
  // leaves the thread, so it is shown as removed rather than hidden.
  it('shows a secondary id with no roots row as a removed folder', async () => {
    const { result } = await setup({ secondaryRootIds: ['r-docs', 'r-ghost'] });
    await waitFor(() =>
      expect(result.current.secondaryRoots).toEqual([
        { displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' },
        { displayName: 'Unknown folder', removed: true, rootId: 'r-ghost' },
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
