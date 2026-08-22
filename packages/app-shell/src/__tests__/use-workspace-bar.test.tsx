import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceBar } from '../hooks/use-workspace-bar';

// `fs` is only dereferenced when the mocked useFileSystem() is CALLED (render
// time), so vitest's vi.mock hoisting above these imports is safe.
const fs = {
  addRootDirectory: vi.fn(async () => ({
    kind: 'directory',
    name: 'docs',
    path: '/ws/docs',
    platform: 'electron',
    rootId: 'r-docs',
  })),
  addRootDirectoryByPath: vi.fn(async (p: string) => ({
    kind: 'directory',
    name: 'alpha',
    path: p,
    platform: 'electron',
    rootId: 'r-alpha',
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
vi.mock('../hooks/use-thread-checkout-status', () => ({
  useThreadCheckoutStatus: () => ({ ahead: 0, behind: 0, branch: 'main', dirty: false }),
}));

const RESOURCE_ID = 'workspace-a';
const THREAD_ID = 'thread-1';

const query = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes('FROM roots') && sql.includes('= ANY')) {
    const ids = (params?.[0] ?? []) as readonly string[];
    return {
      rows: ids.map((id) => ({
        displayName: id.replace('r-', ''),
        id,
        path: `/ws/${id.replace('r-', '')}`,
      })),
    };
  }
  if (sql.includes('FROM roots')) {
    return { rows: [{ id: 'r-docs' }] };
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
const rootDescriptors = {
  'r-main': { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main' },
};

async function setup(metadata: Record<string, unknown> = {}) {
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
  updateThreadMetadata.mockClear();
  fs.addRootDirectory.mockClear();
  fs.addRootDirectoryByPath.mockClear();
  fs.listRecentRoots.mockClear();
});

describe('useWorkspaceBar', () => {
  it('exposes the primary root, checkout, and recents minus the current roots', async () => {
    const { result } = await setup();
    expect(result.current.primaryRoot).toEqual({
      displayName: 'brainstrike',
      path: '/ws/brainstrike',
      rootId: 'r-main',
    });
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

  it('resolves secondaryRootIds to display rows from the roots table', async () => {
    const { result } = await setup({ secondaryRootIds: ['r-docs'] });
    await waitFor(() =>
      expect(result.current.secondaryRoots).toEqual([
        { displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' },
      ])
    );
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

  it('Make primary re-binds the thread (not global MAIN) and demotes the old primary to a secondary', async () => {
    const { result } = await setup({
      operatingRootDisplayName: 'brainstrike',
      operatingRootId: 'r-main',
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
        secondaryRootIds: ['r-main'],
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
});
