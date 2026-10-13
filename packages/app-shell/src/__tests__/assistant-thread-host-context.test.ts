import {
  type AssistantThreadRepository,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import {
  CONTEXT_EXPLORER_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { expect, test, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  createHostAssistantThreadRepository,
  withAssistantThreadHost,
} from '../assistant-thread-host-context';
import { hostChildWorkspaceTabId } from '../host-child-workspace-tab';

const OWNED = new Set(['owned-thread', 'owned-first', 'owned-second']);

function repositories(deleteOwned: AssistantThreadHostCapability['deleteThread']) {
  const history: AssistantThreadRepository = {
    appendThreadRunEvent: vi.fn(),
    completeThreadRun: vi.fn(),
    createThread: vi.fn(),
    createThreadRun: vi.fn(),
    deleteThread: vi.fn(),
    deleteThreads: vi.fn(),
    getCrossRootUsage: vi.fn(),
    getThreadCumulativeUsage: vi.fn(),
    getThreadRunTurnMessageId: vi.fn(),
    listLatestThreadRuns: vi.fn(),
    listMessages: vi.fn(),
    listThreadRunEvents: vi.fn(),
    listThreads: vi.fn(),
    recordRunUsage: vi.fn(),
    renameThread: vi.fn(),
    updateThreadMetadata: vi.fn(),
    updateThreadsMetadata: vi.fn(),
  };
  const host: AssistantThreadHostCapability = {
    createThread: vi.fn(),
    deleteThread: deleteOwned,
    listThreads: vi.fn(),
    ownsThread: vi.fn(async (threadId: string) => OWNED.has(threadId)),
    renameThread: vi.fn(async () => undefined),
    renderThread: vi.fn(),
    updateThreadBinding: vi.fn(async () => undefined),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
  return { history, host, repository: withAssistantThreadHost(history, host) };
}

test('a host-owned thread commits metadata through its host binding, never history', async () => {
  const { history, host, repository } = repositories(vi.fn());
  const binding = { forgePrWatch: false, secondaryRootIds: ['root-a'] };
  await repository.updateThreadMetadata('owned-thread', binding);
  expect(host.updateThreadBinding).toHaveBeenCalledExactlyOnceWith('owned-thread', binding);
  expect(history.updateThreadMetadata).not.toHaveBeenCalled();
});

test('a refused host binding rejects and never falls through to history', async () => {
  const { history, host, repository } = repositories(vi.fn());
  const refusal = new Error('Agent host threads do not store color yet; nothing was changed.');
  vi.mocked(host.updateThreadBinding).mockRejectedValueOnce(refusal);
  await expect(repository.updateThreadMetadata('owned-thread', { color: 'rose' })).rejects.toBe(
    refusal
  );
  expect(history.updateThreadMetadata).not.toHaveBeenCalled();
});

test('a historical thread keeps its existing metadata repository', async () => {
  const { history, host, repository } = repositories(vi.fn());
  await repository.updateThreadMetadata('legacy-thread', { color: 'rose' });
  expect(history.updateThreadMetadata).toHaveBeenCalledExactlyOnceWith('legacy-thread', {
    color: 'rose',
  });
  expect(host.updateThreadBinding).not.toHaveBeenCalled();
});

test('renaming a host-owned thread commits its title through the host, never history', async () => {
  const { history, host, repository } = repositories(vi.fn());
  await repository.renameThread('owned-thread', 'Renamed');
  expect(host.renameThread).toHaveBeenCalledExactlyOnceWith('owned-thread', 'Renamed');
  expect(history.renameThread).not.toHaveBeenCalled();
});

test('a refused host rename keeps the committed title instead of an optimistic one', async () => {
  const { history, host, repository } = repositories(vi.fn());
  vi.mocked(host.renameThread).mockRejectedValueOnce(new Error('Host refused the title'));
  const committed = {
    createdAt: new Date('2026-10-08T00:00:00.000Z'),
    id: 'owned-thread',
    resourceId: 'workspace',
    title: 'Committed title',
    updatedAt: new Date('2026-10-08T00:00:00.000Z'),
  };
  useAssistantThreadStore.setState({ threadsByResourceId: { workspace: [committed] } });
  await expect(
    useAssistantThreadStore
      .getState()
      .renameThread(repository, 'workspace', 'owned-thread', 'Optimistic title')
  ).rejects.toThrow();
  expect(useAssistantThreadStore.getState().threadsByResourceId['workspace']).toEqual([committed]);
  expect(history.renameThread).not.toHaveBeenCalled();
});

test('renaming a historical thread keeps its existing repository', async () => {
  const { history, repository } = repositories(vi.fn());
  await repository.renameThread('legacy-thread', 'Renamed');
  expect(history.renameThread).toHaveBeenCalledExactlyOnceWith('legacy-thread', 'Renamed');
});

test('thread deletion waits for its host owner and never sends a failed owned deletion to history', async () => {
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<readonly string[] | undefined>();
  const { history, repository } = repositories(async () => {
    entered.resolve();
    return joined.promise;
  });
  let settled = false;
  const deletion = repository.deleteThread('owned-thread').then(
    () => {
      settled = true;
    },
    (cause: unknown) => {
      settled = true;
      throw cause;
    }
  );
  await entered.promise;
  expect(settled).toBe(false);
  expect(history.deleteThread).not.toHaveBeenCalled();
  const failure = new Error('Native owner did not join');
  joined.reject(failure);
  await expect(deletion).rejects.toBe(failure);
  expect(history.deleteThread).not.toHaveBeenCalled();
});

test('mixed bulk deletion leaves only legacy identities with their history owner', async () => {
  const deleted: string[] = [];
  const { history, repository } = repositories(async (threadId) => {
    if (threadId === 'legacy-thread') {
      return;
    }
    deleted.push(threadId);
    return [threadId];
  });
  await repository.deleteThreads?.(['owned-first', 'legacy-thread', 'owned-second']);
  expect(deleted).toEqual(['owned-first', 'owned-second']);
  expect(history.deleteThreads).toHaveBeenCalledExactlyOnceWith(['legacy-thread']);
  expect(history.deleteThread).not.toHaveBeenCalled();
  await repository.deleteThread('legacy-thread');
  expect(history.deleteThread).toHaveBeenCalledExactlyOnceWith('legacy-thread');
});

const childTab = (threadId: string) => hostChildWorkspaceTabId({ persona: 'worker', threadId });

test('deleting a host thread closes the open tabs of every child thread it deleted', async () => {
  // The host reports the deleted subtree, children first (thread/delete threadIds).
  const { repository } = repositories(async () => ['grandchild', 'child', 'owned-thread']);
  useWorkspaceTabSelectionStore
    .getState()
    .hydrate(
      [
        CONTEXT_EXPLORER_APP_ID,
        childTab('child'),
        childTab('unrelated-child'),
        childTab('grandchild'),
      ],
      { appId: childTab('grandchild'), kind: 'app' }
    );
  await repository.deleteThread('owned-thread');
  const { openAppIds, selection } = useWorkspaceTabSelectionStore.getState();
  expect(openAppIds).toEqual([CONTEXT_EXPLORER_APP_ID, childTab('unrelated-child')]);
  expect(selection).not.toEqual({ appId: childTab('grandchild'), kind: 'app' });
});

test('a bulk deletion closes the child tabs of each host thread it deleted, not history ones', async () => {
  const { history, repository } = repositories(async (threadId) => {
    if (threadId === 'legacy-thread') {
      return;
    }
    return [`${threadId}-child`, threadId];
  });
  useWorkspaceTabSelectionStore
    .getState()
    .hydrate([childTab('owned-first-child'), childTab('owned-second-child'), childTab('kept')], {
      appId: childTab('kept'),
      kind: 'app',
    });
  await repository.deleteThreads?.(['owned-first', 'legacy-thread', 'owned-second']);
  expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([childTab('kept')]);
  expect(history.deleteThreads).toHaveBeenCalledExactlyOnceWith(['legacy-thread']);
});

test('desktop offers only the authoritative host catalog and web retains its repository', async () => {
  const { history, host, repository } = repositories(vi.fn());
  const current = {
    createdAt: new Date(),
    id: 'owned-thread',
    resourceId: 'workspace',
    title: 'Current conversation',
    updatedAt: new Date(),
  };
  vi.mocked(host.listThreads).mockResolvedValue([current]);
  vi.mocked(history.listThreads).mockResolvedValue([{ ...current, id: 'retired-thread' }]);
  expect(await repository.listThreads('workspace')).toEqual([current]);
  expect(history.listThreads).not.toHaveBeenCalled();
  expect(withAssistantThreadHost(history, undefined)).toBe(history);
});

test('the host-only catalog refuses unowned mutations without consulting history', async () => {
  const { host, history } = repositories(vi.fn(async () => undefined));
  const catalog = createHostAssistantThreadRepository(host);
  await expect(catalog.renameThread('unowned', 'Title')).rejects.toBeInstanceOf(Error);
  await expect(catalog.updateThreadMetadata('unowned', { color: 'rose' })).rejects.toBeInstanceOf(
    Error
  );
  await expect(catalog.deleteThread('unowned')).rejects.toBeInstanceOf(Error);
  expect(host.renameThread).not.toHaveBeenCalled();
  expect(host.updateThreadBinding).not.toHaveBeenCalled();
  expect(history.renameThread).not.toHaveBeenCalled();
  expect(history.updateThreadMetadata).not.toHaveBeenCalled();
  expect(history.deleteThread).not.toHaveBeenCalled();
  await expect(catalog.deleteThreads?.(['unowned'])).rejects.toBeInstanceOf(Error);
  expect(catalog.updateThreadsMetadata).toBeUndefined();
});

test('host-only mutations preserve the original owner failure', async () => {
  const failure = new Error('Owned write failed');
  const { host } = repositories(
    vi.fn(async () => {
      throw failure;
    })
  );
  vi.mocked(host.renameThread).mockRejectedValueOnce(failure);
  vi.mocked(host.updateThreadBinding).mockRejectedValueOnce(failure);
  const catalog = createHostAssistantThreadRepository(host);
  await expect(catalog.renameThread('owned-thread', 'Title')).rejects.toBe(failure);
  await expect(catalog.updateThreadMetadata('owned-thread', { color: 'rose' })).rejects.toBe(
    failure
  );
  await expect(catalog.deleteThread('owned-thread')).rejects.toBe(failure);
});

test('host-only deletion keeps child tabs until the owner joins the physical deletion', async () => {
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<readonly string[]>();
  const { host } = repositories(async () => {
    entered.resolve();
    return joined.promise;
  });
  useWorkspaceTabSelectionStore
    .getState()
    .hydrate([childTab('child'), childTab('kept')], { appId: childTab('child'), kind: 'app' });
  const deletion = createHostAssistantThreadRepository(host).deleteThread('owned-thread');
  await entered.promise;
  expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([
    childTab('child'),
    childTab('kept'),
  ]);
  joined.resolve(['child', 'owned-thread']);
  await deletion;
  expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([childTab('kept')]);
});

test('host-only bulk deletion keeps the existing sequential physical joins and rejects an unowned remainder', async () => {
  const first = Promise.withResolvers<readonly string[]>();
  const deletion = vi.fn(async (id: string) =>
    id === 'owned-first' ? await first.promise : undefined
  );
  const { host, history } = repositories(deletion);
  const catalog = createHostAssistantThreadRepository(host);
  if (!catalog.deleteThreads) {
    throw new Error('Host bulk deletion is missing');
  }
  const result = catalog.deleteThreads(['owned-first', 'unowned']);
  const observed = result.catch((error) => error);
  expect(deletion).toHaveBeenCalledExactlyOnceWith('owned-first');
  first.resolve(['owned-first']);
  expect(await observed).toBeInstanceOf(Error);
  expect(deletion.mock.calls).toEqual([['owned-first'], ['unowned']]);
  expect(history.deleteThreads).not.toHaveBeenCalled();
});
