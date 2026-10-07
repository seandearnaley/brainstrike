import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { expect, test, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  withAssistantThreadHost,
} from '../assistant-thread-host-context';

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
  };
  const host: AssistantThreadHostCapability = {
    createThread: vi.fn(),
    deleteThread: deleteOwned,
    listThreads: vi.fn(),
    renderThread: vi.fn(),
    workspaceRepository: (repository) => repository,
  };
  return { history, repository: withAssistantThreadHost(history, host) };
}

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
