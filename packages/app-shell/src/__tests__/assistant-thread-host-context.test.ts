import {
  type AssistantThreadRepository,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import { expect, test, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  withAssistantThreadHost,
} from '../assistant-thread-host-context';

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
    listThreadCheckpoints: vi.fn(),
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
    renderThread: vi.fn(),
    updateThreadBinding: vi.fn(async () => undefined),
    workspaceRepository: (repository) => repository,
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

test('renaming a host-owned thread refuses visibly and never writes history', async () => {
  const { history, repository } = repositories(vi.fn());
  await expect(repository.renameThread('owned-thread', 'Renamed')).rejects.toThrow();
  expect(history.renameThread).not.toHaveBeenCalled();
});

test('a refused host rename keeps the committed title instead of an optimistic one', async () => {
  const { repository } = repositories(vi.fn());
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
});

test('renaming a historical thread keeps its existing repository', async () => {
  const { history, repository } = repositories(vi.fn());
  await repository.renameThread('legacy-thread', 'Renamed');
  expect(history.renameThread).toHaveBeenCalledExactlyOnceWith('legacy-thread', 'Renamed');
});

test('thread deletion waits for its host owner and never sends a failed owned deletion to history', async () => {
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<boolean>();
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
      return false;
    }
    deleted.push(threadId);
    return true;
  });
  await repository.deleteThreads?.(['owned-first', 'legacy-thread', 'owned-second']);
  expect(deleted).toEqual(['owned-first', 'owned-second']);
  expect(history.deleteThreads).toHaveBeenCalledExactlyOnceWith(['legacy-thread']);
  expect(history.deleteThread).not.toHaveBeenCalled();
  await repository.deleteThread('legacy-thread');
  expect(history.deleteThread).toHaveBeenCalledExactlyOnceWith('legacy-thread');
});
