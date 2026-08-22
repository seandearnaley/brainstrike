import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { ActionOutcome } from '@brainstrike/context-actions';
import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { checkoutSpy, clipboardWriteText, loggerMock, toastSpy } = vi.hoisted(() => ({
  checkoutSpy: vi.fn((_rootId: string | null) => ({
    ahead: 0,
    behind: 0,
    branch: 'main',
    dirty: false,
  })),
  clipboardWriteText: vi.fn(),
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

vi.mock('../hooks/use-thread-checkout-status', () => ({ useThreadCheckoutStatus: checkoutSpy }));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ dismiss: vi.fn(), toast: toastSpy, toasts: [] }),
}));
vi.mock('@brainstrike/context-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/context-actions')>()),
  createClipboardService: () => ({ writeText: clipboardWriteText }),
}));

const RESOURCE_ID = 'workspace-a';
const THREAD_ID = 'thread-1';

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
// Hoisted on purpose: the wrapper passes store/context references, which are
// stable across renders. Fresh literals per render would only exercise a
// caller-side identity bug, not this hook.
const database = { query } as unknown as DbHandle;
const assistantThreadRepository = {
  updateThreadMetadata,
} as unknown as AssistantThreadRepository;
const currentMainRoot = { displayName: 'brainstrike', path: '/ws/brainstrike' };
// `rootId` here is the ADAPTER id — it must never reach the bar.
const rootDescriptors = {
  'r-main': { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'adapter-main' },
};

function seedThread(metadata: Record<string, unknown>) {
  useAssistantThreadStore.setState({
    ...useAssistantThreadStore.getState(),
    selectedThreadByResourceId: { [RESOURCE_ID]: THREAD_ID },
    threadsByResourceId: {
      [RESOURCE_ID]: [
        {
          createdAt: new Date(),
          id: THREAD_ID,
          metadata,
          resourceId: RESOURCE_ID,
          title: 't',
          updatedAt: new Date(),
        },
      ],
    },
  });
}

function copyPathOf(props: { readonly onCopyPath?: ((path: string) => void) | undefined }) {
  const { onCopyPath } = props;
  if (!onCopyPath) {
    throw new Error('the workspace bar must always expose onCopyPath');
  }
  return onCopyPath;
}

async function setup(metadata: Record<string, unknown> = {}) {
  seedThread(metadata);
  const rendered = renderHook(() =>
    useWorkspaceBar({
      assistantThreadRepository,
      currentMainRoot,
      database,
      memoryResourceId: RESOURCE_ID,
      rootDescriptors,
      selectedMemoryThreadId: THREAD_ID,
    })
  );
  // Let the mount-time roots/recents reads settle inside act so no state
  // update escapes the test's act() scope.
  await act(async () => {});
  return rendered;
}

beforeEach(() => {
  currentFs = fs;
  liveRootMisses.clear();
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue({ ok: true } satisfies ActionOutcome);
  checkoutSpy.mockClear();
  toastSpy.mockClear();
  loggerMock.error.mockClear();
  loggerMock.warn.mockClear();
  query.mockClear();
  updateThreadMetadata.mockClear();
  fs.addRootDirectory.mockClear();
  fs.addRootDirectoryByPath.mockClear();
  fs.listRecentRoots.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWorkspaceBar', () => {
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
    await waitFor(() =>
      expect(result.current.recentRoots).toEqual([{ displayName: 'alpha', path: '/ws/alpha' }])
    );
    expect(result.current.onAddRecent).toBeDefined();
  });

  it('resolves the unbound primary by PATH in the durable roots table, never the adapter id', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.primaryRoot?.rootId).toBe('r-main-db'));
    // The checkout read is a DB-space consumer: it must see the roots row id.
    expect(checkoutSpy).toHaveBeenCalledWith('r-main-db');
    expect(checkoutSpy).not.toHaveBeenCalledWith('adapter-main');
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
    // Never an invented id.
    expect(checkoutSpy).not.toHaveBeenCalledWith('adapter-main');
    expect(checkoutSpy).toHaveBeenCalledWith(null);
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

  it('says nothing when Copy path succeeds', async () => {
    const { result } = await setup();
    await act(async () => {
      copyPathOf(result.current)('/ws/docs');
    });
    expect(clipboardWriteText).toHaveBeenCalledWith('/ws/docs');
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
