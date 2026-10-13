/**
 * BST-1990: the workspace bar reads a thread folder's `roots` row status, marks
 * a folder the workspace no longer serves, re-reads when the mounted set
 * changes, and writes the repairs. It also adds a mounted folder outside the
 * thread through the one add-secondary write. The pure repair derives are pinned in
 * `use-workspace-bar-removed-folder.test.ts`; this file pins the hook's reads
 * and writes. Fixtures are per file because each Vitest file owns its mocks.
 */
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useWorkspaceBar } from '../hooks/use-workspace-bar';
import { resetRootRegistrationEventsForTests } from '../roots/root-registration-events';

const fs = {
  addRootDirectory: vi.fn(),
  addRootDirectoryByPath: vi.fn(),
  isFileSystemAccessSupported: vi.fn(() => ({ reason: '', supported: true })),
  listRecentRoots: vi.fn(async () => []),
  recentRootsRevision: 0,
  registerRestoredHandles: vi.fn(),
};
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({ useFileSystem: () => fs }));

const { loggerMock, toastSpy } = vi.hoisted(() => ({
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
vi.mock('../hooks/use-branch-switcher', () => ({ useBranchSwitcher: () => undefined }));
vi.mock('../hooks/use-thread-forge-pr', () => ({
  useThreadForgePr: () => ({ diagnostic: null, refresh: vi.fn(), status: null }),
}));
vi.mock('../hooks/use-thread-checkout-status', () => ({
  useThreadCheckoutStatus: () => ({ checkout: undefined, settled: true }),
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastSpy,
}));

const RESOURCE_ID = 'workspace-a';
const THREAD_ID = 'thread-1';
const ROWS: Record<string, { displayName: string; path: string; status: string }> = {
  'r-alpha': { displayName: 'alpha', path: '/ws/alpha', status: 'live' },
  'r-bravo': { displayName: 'bravo', path: '/ws/bravo', status: 'disconnected' },
  'r-charlie': { displayName: 'charlie', path: '/ws/charlie', status: 'live' },
};
const query = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes('FROM roots') && sql.includes('= ANY')) {
    const ids = (params?.[0] ?? []) as readonly string[];
    return {
      rows: ids.flatMap((id) => {
        const row = ROWS[id];
        return row ? [{ ...row, id }] : [];
      }),
    };
  }
  if (sql.includes('FROM roots')) {
    const path = params?.[0];
    const id = Object.entries(ROWS).find(([, row]) => row.path === path)?.[0];
    return { rows: id ? [{ id }] : [] };
  }
  return { rows: [] };
});
const database = { query } as unknown as DbHandle;
const updateThreadMetadata = vi.fn(async () => {});
const assistantThreadRepository = { updateThreadMetadata } as unknown as AssistantThreadRepository;

type Descriptors = Record<string, { displayName: string; path: string; rootId: string }>;
const ALPHA_AND_CHARLIE: Descriptors = {
  'adapter-alpha': { displayName: 'alpha', path: '/ws/alpha', rootId: 'adapter-alpha' },
  'adapter-charlie': { displayName: 'charlie', path: '/ws/charlie', rootId: 'adapter-charlie' },
};

async function setup(metadata: Record<string, unknown>, rootDescriptors: Descriptors) {
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
  const rendered = renderHook(
    (props: { rootDescriptors: Descriptors }) =>
      useWorkspaceBar({
        assistantThreadRepository,
        currentMainRoot: { displayName: 'alpha', path: '/ws/alpha' },
        database,
        memoryResourceId: RESOURCE_ID,
        rootDescriptors: props.rootDescriptors,
        selectedMemoryThreadId: THREAD_ID,
      }),
    { initialProps: { rootDescriptors } }
  );
  await act(async () => {});
  return rendered;
}

const BRAVO_PRIMARY = {
  operatingRootDisplayName: 'bravo',
  operatingRootId: 'r-bravo',
  operatingRootPath: '/ws/bravo',
};

beforeEach(() => {
  ROWS['r-bravo'] = { displayName: 'bravo', path: '/ws/bravo', status: 'disconnected' };
  resetRootRegistrationEventsForTests();
  useChangesLiveRefreshStore.getState().reset();
  query.mockClear();
  toastSpy.mockClear();
  updateThreadMetadata.mockClear();
});

describe('a thread folder the workspace no longer serves', () => {
  it('is marked removed, and a re-added folder is live again once the mounted set changes', async () => {
    const { rerender, result } = await setup(
      { ...BRAVO_PRIMARY, secondaryRootIds: ['r-alpha'] },
      ALPHA_AND_CHARLIE
    );
    await waitFor(() => expect(result.current.primaryRoot?.removed).toBe(true));
    expect(result.current.secondaryRoots).toEqual([
      { displayName: 'alpha', path: '/ws/alpha', rootId: 'r-alpha' },
    ]);
    ROWS['r-bravo'] = { displayName: 'bravo', path: '/ws/bravo', status: 'live' };
    rerender({
      rootDescriptors: {
        ...ALPHA_AND_CHARLIE,
        'adapter-bravo': { displayName: 'bravo', path: '/ws/bravo', rootId: 'adapter-bravo' },
      },
    });
    await waitFor(() => expect(result.current.primaryRoot?.removed).toBeUndefined());
  });

  it('as the primary, leaves the thread in one write that promotes the live folder', async () => {
    const { result } = await setup(
      { ...BRAVO_PRIMARY, secondaryRootIds: ['r-alpha'] },
      ALPHA_AND_CHARLIE
    );
    await waitFor(() => expect(result.current.primaryRoot?.removed).toBe(true));
    await act(async () => {
      result.current.onRemovePrimary('r-bravo');
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        operatingRootDisplayName: 'alpha',
        operatingRootId: 'r-alpha',
        operatingRootPath: '/ws/alpha',
        secondaryRootIds: [],
      })
    );
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
  });

  it('with no live folder left, gives way to another mounted workspace folder', async () => {
    const { result } = await setup({ ...BRAVO_PRIMARY }, ALPHA_AND_CHARLIE);
    await waitFor(() => expect(result.current.primaryRoot?.removed).toBe(true));
    expect(result.current.workspaceFolders).toEqual([
      { displayName: 'alpha', path: '/ws/alpha' },
      { displayName: 'charlie', path: '/ws/charlie' },
    ]);
    await act(async () => {
      result.current.onUseFolder({ displayName: 'charlie', path: '/ws/charlie' });
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(THREAD_ID, {
        operatingRootDisplayName: 'charlie',
        operatingRootId: 'r-charlie',
        operatingRootPath: '/ws/charlie',
        secondaryRootIds: [],
      })
    );
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

describe('a mounted folder outside the thread', () => {
  it('is added to the thread through the add-secondary write, with no picker', async () => {
    const { result } = await setup(
      {
        operatingRootDisplayName: 'alpha',
        operatingRootId: 'r-alpha',
        operatingRootPath: '/ws/alpha',
      },
      ALPHA_AND_CHARLIE
    );
    await waitFor(() =>
      expect(result.current.workspaceFolders).toEqual([
        { displayName: 'charlie', path: '/ws/charlie' },
      ])
    );
    await act(async () => {
      result.current.onAddWorkspaceFolder({ displayName: 'charlie', path: '/ws/charlie' });
    });
    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({ secondaryRootIds: ['r-charlie'] })
      )
    );
    expect(fs.addRootDirectory).not.toHaveBeenCalled();
    expect(fs.addRootDirectoryByPath).not.toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
