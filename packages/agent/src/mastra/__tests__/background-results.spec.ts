import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { MastraMemory } from '@mastra/core/memory';
import { expect, it } from 'vitest';
import { repairBackgroundResults } from '../background-results';

function task(index: number): BackgroundTask {
  return {
    agentId: 'parent',
    args: { prompt: String(index) },
    completedAt: new Date(),
    createdAt: new Date(1000 + index),
    id: `task-${index}`,
    maxRetries: 0,
    resourceId: 'owner',
    result: { text: `result-${index}` },
    retryCount: 0,
    runId: 'run',
    status: 'completed',
    threadId: 'root',
    timeoutMs: 30_000,
    toolCallId: `call-${index}`,
    toolName: 'agent-worker',
  };
}

it('drains page zero while local and concurrent acknowledgements mutate the undelivered set', async () => {
  const tasks = Array.from({ length: 202 }, (_, index) => task(index));
  const undelivered = new Map(tasks.map((entry) => [entry.id, entry]));
  const saved: string[] = [];
  const requestedPages: number[] = [];
  let listingCount = 0;
  const delivery = {
    listUndeliveredTasks: ({ page = 0, perPage = 100 }: { page?: number; perPage?: number }) => {
      listingCount += 1;
      requestedPages.push(page);
      if (listingCount === 2) {
        undelivered.delete('task-100');
      }
      const current = [...undelivered.values()];
      return Promise.resolve({
        tasks: current.slice(page * perPage, (page + 1) * perPage),
        total: current.length,
      });
    },
    markResultDelivered: () => Promise.resolve(),
  };
  const manager = {
    getStorage: () => Promise.resolve(delivery),
  } as unknown as BackgroundTaskManager;
  const memory = {
    storage: {
      getStore: () =>
        Promise.resolve({
          saveBackgroundTaskResult: ({ taskId }: { taskId: string }) => {
            saved.push(taskId);
            undelivered.delete(taskId);
            return Promise.resolve([]);
          },
        }),
    },
  } as unknown as MastraMemory;

  await expect(
    repairBackgroundResults({
      manager,
      memory,
      scope: { resourceId: 'owner', threadId: 'root' },
    })
  ).resolves.toEqual(tasks.map(({ id }) => id).filter((id) => id !== 'task-100'));
  expect(saved).toEqual(tasks.map(({ id }) => id).filter((id) => id !== 'task-100'));
  expect(requestedPages).toEqual([0, 0, 0, 0]);
});
