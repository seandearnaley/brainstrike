/**
 * ADR-0034: every checkout change waits for the thread's run to end, because a
 * run keeps the checkout it was admitted with. In a worktree, three folder
 * actions leave the worktree (the thread is Local again): Make primary, Remove
 * from this thread on the worktree folder or the Local folder, and Use another
 * folder…. While a run is in progress the bar says why and refuses them. In
 * Local they change no checkout and are not held. Fixtures are per file because
 * each Vitest file owns its mocks.
 */
import type {
  AssistantThreadRepository,
  AssistantThreadRunRecord,
} from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useWorkspaceBar } from '../hooks/use-workspace-bar';
import { resetRootRegistrationEventsForTests } from '../roots/root-registration-events';

const fs = {
  addRootDirectory: vi.fn(),
  addRootDirectoryByPath: vi.fn(),
  folderRequests: { failures: new Map<string, string>(), opening: new Map<string, number>() },
  isFileSystemAccessSupported: vi.fn(() => ({ reason: '', supported: true })),
  listRecentRoots: vi.fn(async () => []),
  recentRootsRevision: 0,
  registerRestoredHandles: vi.fn(),
};
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({ useFileSystem: () => fs }));

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock('../hooks/use-branch-switcher', () => ({
  useBranchSwitcher: () => ({ menu: undefined, settled: true }),
}));
vi.mock('../hooks/use-thread-checkout-status', () => ({
  useThreadCheckoutStatus: () => ({ checkout: undefined, settled: true }),
}));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastSpy,
}));

const RUN_IN_PROGRESS = "Available when this thread's run ends.";
const RESOURCE_ID = 'workspace-a';
const THREAD_ID = 'thread-1';
const ROWS: Record<string, { displayName: string; path: string }> = {
  'r-app': { displayName: 'app', path: '/ws/app' },
  'r-docs': { displayName: 'docs', path: '/ws/docs' },
  'r-fox': { displayName: 'fox', path: '/managed/app/fox' },
};
const readRoots = vi.fn(async () =>
  Object.entries(ROWS).map(([id, row]) => ({ ...row, id, status: 'live' }))
);
const updateThreadMetadata = vi.fn(async () => {});
const assistantThreadRepository = { updateThreadMetadata } as unknown as AssistantThreadRepository;
const rootDescriptors = Object.fromEntries(
  Object.entries(ROWS).map(([id, row]) => [`adapter-${id}`, { ...row, rootId: `adapter-${id}` }])
);

/** In worktree `fox` of `app`, with `docs` as a further folder. */
const IN_WORKTREE = {
  checkoutLocalRootId: 'r-app',
  checkoutMode: 'worktree',
  checkoutWorktreeId: 'w-1',
  checkoutWorktreePath: '/managed/app/fox',
  operatingRootDisplayName: 'fox',
  operatingRootId: 'r-fox',
  operatingRootPath: '/managed/app/fox',
  secondaryRootIds: ['r-app', 'r-docs'],
};
/** Local in `app`, with `docs` as a further folder. */
const IN_LOCAL = {
  operatingRootDisplayName: 'app',
  operatingRootId: 'r-app',
  operatingRootPath: '/ws/app',
  secondaryRootIds: ['r-docs'],
};

function run(status: AssistantThreadRunRecord['status']): AssistantThreadRunRecord {
  const at = new Date('2026-11-11T00:00:00.000Z');
  return {
    completedAt: null,
    createdAt: at,
    error: null,
    id: 'run-1',
    model: 'gpt-5.4',
    provider: 'openai',
    resourceId: RESOURCE_ID,
    runtimeKind: 'hosted',
    startedAt: at,
    status,
    threadId: THREAD_ID,
    turnMessageId: null,
    updatedAt: at,
  };
}

async function setup(
  metadata: { readonly secondaryRootIds: readonly string[] } & Record<string, unknown>,
  latestRun: AssistantThreadRunRecord['status']
) {
  useAssistantThreadStore.setState({
    ...useAssistantThreadStore.getState(),
    selectedThreadByResourceId: { [RESOURCE_ID]: THREAD_ID },
    threadsByResourceId: {
      [RESOURCE_ID]: [
        {
          createdAt: new Date(),
          id: THREAD_ID,
          latestRun: run(latestRun),
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
      memoryResourceId: RESOURCE_ID,
      rootDescriptors,
      selectedMemoryThreadId: THREAD_ID,
    })
  );
  await act(async () => {});
  // Make primary derives from the loaded folder rows.
  await waitFor(() =>
    expect(rendered.result.current.secondaryRoots).toHaveLength(metadata.secondaryRootIds.length)
  );
  return rendered;
}

afterEach(() => Reflect.deleteProperty(window, 'threadGroups'));

beforeEach(() => {
  resetRootRegistrationEventsForTests();
  useChangesLiveRefreshStore.getState().reset();
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: { readRoots: async () => ({ ok: true, value: await readRoots() }) },
  });
  toastSpy.mockClear();
  updateThreadMetadata.mockClear();
});

describe('Make primary while the thread runs (ADR-0034)', () => {
  it('in a worktree, says why it waits and refuses with the reason', async () => {
    const { result } = await setup(IN_WORKTREE, 'running');
    expect(result.current.leaveWorktreeDisabledReason).toBe(RUN_IN_PROGRESS);

    await act(async () => {
      result.current.onMakePrimary('r-docs');
    });

    expect(toastSpy).toHaveBeenCalledExactlyOnceWith({
      description: RUN_IN_PROGRESS,
      title: 'Could not make that folder primary',
      variant: 'destructive',
    });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
  });

  it('in a worktree, leaves it once the run has ended', async () => {
    const { result } = await setup(IN_WORKTREE, 'completed');
    expect(result.current.leaveWorktreeDisabledReason).toBeUndefined();

    await act(async () => {
      result.current.onMakePrimary('r-docs');
    });

    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({ checkoutMode: 'local', operatingRootId: 'r-docs' })
      )
    );
  });

  it('in Local, changes no checkout and is not held by the run', async () => {
    const { result } = await setup(IN_LOCAL, 'running');
    expect(result.current.leaveWorktreeDisabledReason).toBeUndefined();

    await act(async () => {
      result.current.onMakePrimary('r-docs');
    });

    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({ operatingRootId: 'r-docs' })
      )
    );
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

describe('the other folder actions that leave a worktree, while the thread runs', () => {
  it.each([
    ['removing the worktree folder', 'Could not remove that folder from this thread'],
    ['removing the Local folder', 'Could not remove that folder from this thread'],
    ['using another folder', 'Could not use that folder'],
  ] as const)('refuses %s with the reason', async (action, title) => {
    const { result } = await setup(IN_WORKTREE, 'running');

    await act(async () => {
      if (action === 'removing the worktree folder') {
        result.current.onRemovePrimary('r-fox');
      } else if (action === 'removing the Local folder') {
        result.current.onRemoveSecondary('r-app');
      } else {
        result.current.onUseFolder({ displayName: 'docs', path: '/ws/docs' });
      }
    });

    expect(toastSpy).toHaveBeenCalledExactlyOnceWith({
      description: RUN_IN_PROGRESS,
      title,
      variant: 'destructive',
    });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
  });

  it('still removes a further folder, which leaves no checkout', async () => {
    const { result } = await setup(IN_WORKTREE, 'running');

    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });

    await waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({ secondaryRootIds: ['r-app'] })
      )
    );
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
