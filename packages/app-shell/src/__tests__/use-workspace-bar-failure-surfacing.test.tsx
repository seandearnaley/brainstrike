/**
 * useWorkspaceBar's failure/success toast surfacing — Copy path, Add folder,
 * a recent folder that can no longer be re-mounted, Make primary / Remove
 * folder, and the metadata-not-loaded-yet refusal. Every case here shares one
 * shape: a user action either raises a toast naming the actual remedy or
 * (Copy path succeeding) raises none at all — never a bare log, never a
 * generic "something went wrong".
 *
 * Split out of `use-workspace-bar.test.tsx`, which crossed Biome's 1000-line
 * cap. The shared fixtures below are duplicated rather than imported: each
 * Vitest file needs its OWN `vi.mock`/`vi.hoisted` registrations (mocking is
 * scoped per test file, so a hoisted spy cannot be shared by reference across
 * files), and everything else here participates in that per-file mock setup
 * (`beforeEach` resets it, `setup()` renders through it) closely enough that
 * splitting it out would just relocate the same coupling rather than remove
 * it. Two helpers unused on this side (`flush`, `openLiveRootGate`) were
 * dropped rather than carried over dead.
 */
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { WorkspaceBarBranchMenu } from '@brainstrike/assistant-ui';
import type { ActionOutcome } from '@brainstrike/context-actions';
import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import type { ThreadCheckoutFolders } from '../hooks/use-thread-folders-write';
import { deriveMakePrimary, useWorkspaceBar } from '../hooks/use-workspace-bar';

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
let secondaryRootsError: Error | null = null;
let secondaryRootsGate: { promise: Promise<void>; release: () => void } | null = null;
const query = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes('FROM roots') && sql.includes('= ANY')) {
    if (secondaryRootsGate) {
      await secondaryRootsGate.promise;
    }
    if (secondaryRootsError) {
      throw secondaryRootsError;
    }
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

const MAKE_PRIMARY_FOLDERS = {
  checkoutLocalRootId: undefined,
  checkoutMode: 'local',
  metadataPending: false,
  primaryRoot: { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main-db' },
  primaryRootId: 'r-main-db',
  secondaryRootIds: ['r-docs'],
  secondaryRoots: [{ displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' }],
  secondaryRootsError: false,
  secondaryRootsPending: false,
  threadId: THREAD_ID,
} satisfies ThreadCheckoutFolders;

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

function openSecondaryRootsGate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
  secondaryRootsError = null;
  secondaryRootsGate = null;
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

describe('useWorkspaceBar — failure and success surfacing', () => {
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

  // F4's onCopyUrl regression test lives in use-workspace-bar-forge.test.ts.

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

  it('strips a CLASS-named envelope (AccessError) too — the shape main actually throws', async () => {
    // Main's picker-less gate throws an AccessError, and the class NAME
    // survives IPC serialization (BST-1393 L5 live finding). This pins the
    // SHARED stripper (`workspace-connect-bridge.ts`'s
    // `stripIpcInvokeEnvelope`) from THIS consumer — PR #2686 review: the
    // previous per-file regex copy was untested here, so reverting its
    // widening was silently green while this toast showed `AccessError: …`.
    fs.addRootDirectoryByPath.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'fs:addRootByPath': AccessError: Folder was never granted in this app; use Add Folder to grant it."
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

  it('toasts a refused Make primary without poisoning the next queued write', async () => {
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs'],
    });
    await waitFor(() => expect(result.current.secondaryRoots).toHaveLength(1));

    await act(async () => {
      result.current.onMakePrimary('r-missing');
    });

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'Could not make primary: secondary root r-missing is unknown or has no path.',
        title: 'Make primary failed',
        variant: 'destructive',
      })
    );
    expect(updateThreadMetadata).not.toHaveBeenCalled();

    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        secondaryRootIds: [],
      })
    );
  });

  it('rejects Make primary when the requested secondary root cannot be resolved', () => {
    expect(() => deriveMakePrimary(MAKE_PRIMARY_FOLDERS, 'r-missing')).toThrow(
      'Could not make primary: secondary root r-missing is unknown or has no path.'
    );
  });

  it('rejects Make primary when the current primary root cannot be resolved', () => {
    // No organic end-to-end path reaches this branch: `primaryRoot` and
    // `primaryRootId` are always derived together in this codebase's data
    // flow, so the inconsistency below is a defensive invariant guard, not a
    // state the live hook can produce. This synchronous throw is its complete
    // pin.
    expect(() =>
      deriveMakePrimary(
        {
          ...MAKE_PRIMARY_FOLDERS,
          primaryRoot: undefined,
        },
        'r-docs'
      )
    ).toThrow('Could not make primary: current primary root r-main-db is unknown or has no path.');
  });

  it('reports a retryable Make primary refusal while secondary roots are still loading', async () => {
    secondaryRootsGate = openSecondaryRootsGate();
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs'],
    });

    await act(async () => {
      result.current.onMakePrimary('r-docs');
    });

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'Folders are still loading — try again in a moment.',
        title: 'Make primary failed',
        variant: 'destructive',
      })
    );
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(updateThreadMetadata).not.toHaveBeenCalled();

    await act(async () => {
      secondaryRootsGate?.release();
    });
  });

  it('reports an honest Make primary refusal when secondary roots failed to load', async () => {
    secondaryRootsError = new Error('secondary roots query failed');
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main-db',
      operatingRootPath: '/ws/brainstrike',
      secondaryRootIds: ['r-docs'],
    });
    await waitFor(() =>
      expect(loggerMock.error).toHaveBeenCalledWith(
        'failed to load the thread secondary roots',
        expect.anything()
      )
    );

    await act(async () => {
      result.current.onMakePrimary('r-docs');
    });

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'Folders failed to load — reopen the thread or restart to retry.',
        title: 'Make primary failed',
        variant: 'destructive',
      })
    );
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(updateThreadMetadata).not.toHaveBeenCalled();
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

    // Same capture as the no-active-thread refusal in use-workspace-bar.test.tsx:
    // `enqueueThreadFoldersWrite`'s own promise is never exposed publicly, so
    // the write-queue's REJECTION (not a silent resolve) is proven through the
    // toast its `.catch` raises, which fires with the exact message
    // `refuseWriteBeforeThreadMetadata` throws.
    const writeOutcome = new Promise<void>((_resolve, reject) => {
      toastSpy.mockImplementationOnce(({ description }: { description: string }) => {
        reject(new Error(description));
      });
    });
    // The real assertion is the `await expect(writeOutcome).rejects...` below;
    // this stops Node from flagging the interim window (the promise rejects
    // inside `act()`, before that line attaches a handler) as unhandled.
    writeOutcome.catch(() => undefined);

    await act(async () => {
      result.current.onAddFolder();
    });
    await act(async () => {});

    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Cannot update thread folders before the selected thread metadata is loaded'
    );
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith({
      description: expect.stringContaining('moment'),
      title: 'Add folder failed',
      variant: 'destructive',
    });
    // Last on purpose: a deleted production throw fails this as an immediate,
    // readable assertion diff on the line above instead of a 5s `rejects`
    // timeout with no other signal.
    await expect(writeOutcome).rejects.toThrow(
      "This thread's folders have not loaded yet — try again in a moment."
    );
  });

  // BST-1400 item 12: the affordance disables PROACTIVELY while metadata is
  // pending, rather than only reactively refusing the write above AFTER the
  // OS picker already ran and mounted a folder no thread ends up owning.
  it('exposes addFolderDisabledReason while the selected thread metadata is still loading, then clears it', async () => {
    seedThreads([{ id: OTHER_THREAD_ID, metadata: {} }], THREAD_ID);
    const { rerender, result } = renderHook(
      (props: { selectedMemoryThreadId: string }) =>
        useWorkspaceBar({
          assistantThreadRepository,
          currentMainRoot,
          database,
          memoryResourceId: RESOURCE_ID,
          rootDescriptors,
          selectedMemoryThreadId: props.selectedMemoryThreadId,
        }),
      { initialProps: { selectedMemoryThreadId: THREAD_ID } }
    );
    await act(async () => {});

    expect(result.current.addFolderDisabledReason).toBe("This thread hasn't finished loading yet");

    // The thread's row lands — metadata is no longer pending.
    seedThreads([{ id: THREAD_ID, metadata: {} }], THREAD_ID);
    await act(async () => {
      rerender({ selectedMemoryThreadId: THREAD_ID });
    });

    expect(result.current.addFolderDisabledReason).toBeUndefined();
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
