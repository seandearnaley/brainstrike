import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import type { BackgroundTask } from '@mastra/core/background-tasks';
import { Mastra } from '@mastra/core/mastra';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createPgliteMastraMemory } from '../memory-factory';
import type { PgliteDatabase } from '../types';

let database: PGlite;
function port(db: PGlite): PgliteDatabase {
  return {
    exec: (sql) => db.exec(sql),
    query: (sql, values) => db.query(sql, values ? [...values] : undefined),
  };
}
async function backing(db: PGlite) {
  const memory = await createPgliteMastraMemory({
    database: port(db),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const store = await memory.storage.getStore('backgroundTasks');
  if (!store) {
    throw new Error('Durable background task domain is required');
  }
  return store;
}
function task(id: string): BackgroundTask {
  return {
    agentId: 'parent',
    args: { prompt: 'Work' },
    createdAt: new Date('2026-09-11T09:00:00Z'),
    id,
    maxRetries: 0,
    resourceId: 'owner',
    retryCount: 0,
    runId: 'run',
    status: 'pending',
    threadId: 'root',
    timeoutMs: 30_000,
    toolCallId: `call-${id}`,
    toolName: 'agent-worker',
  };
}
beforeEach(async () => {
  database = await createEnginePglite();
});
afterEach(async () => {
  await database.close();
});

it('retains a completed undelivered child outcome across a new storage wrapper and engine', async () => {
  const store = await backing(database);
  await store.createTask(task('completed-child'));
  const completedAt = new Date('2026-09-11T09:01:00Z');
  await store.updateTask('completed-child', {
    completedAt,
    result: { answer: 'Written once' },
    status: 'completed',
  });
  const restored = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
  try {
    expect(await (await backing(restored)).getTask('completed-child')).toEqual({
      ...task('completed-child'),
      completedAt,
      result: { answer: 'Written once' },
      status: 'completed',
    });
  } finally {
    await restored.close();
  }
});

it('allows exactly one owner to claim a pending task and preserves explicit suspension clearing', async () => {
  const first = await backing(database);
  const second = await backing(database);
  await first.createTask(task('claimed-child'));
  const claims = await Promise.all([
    first.updateTask('claimed-child', { status: 'running' }, { expectedStatus: 'pending' }),
    second.updateTask('claimed-child', { status: 'running' }, { expectedStatus: 'pending' }),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  await first.updateTask('claimed-child', {
    status: 'suspended',
    suspendPayload: { approval: 'exact-call' },
  });
  expect(await second.getTask('claimed-child')).toMatchObject({
    status: 'suspended',
    suspendPayload: { approval: 'exact-call' },
  });
  await second.updateTask('claimed-child', { status: 'running', suspendPayload: undefined });
  expect(await first.getTask('claimed-child')).not.toHaveProperty('suspendPayload');
});

it('limits native manager recovery and every task operation to its conversation owner', async () => {
  const global = await backing(database);
  await global.createTask({ ...task('other-root'), status: 'running' });
  await global.createTask({ ...task('own-root'), status: 'running', threadId: 'root-b' });
  const scoped = await createPgliteMastraMemory({
    backgroundTaskScope: { resourceId: 'owner', threadId: 'root-b' },
    database: port(database),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const host = new Mastra({
    backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
    logger: false,
    storage: scoped.storage,
  });
  try {
    const manager = host.backgroundTaskManager;
    if (!manager) {
      throw new Error('Missing native background manager');
    }
    // resume waits for native startup recovery before looking up this absent ID.
    await expect(manager.resume('missing', {})).rejects.toThrow('Task not found');
    expect(await global.getTask('other-root')).toMatchObject({ status: 'running' });
    expect(await global.getTask('own-root')).toMatchObject({ status: 'failed' });
    const store = await scoped.storage.getStore('backgroundTasks');
    if (!store) {
      throw new Error('Missing scoped task domain');
    }
    expect(await store.getTask('other-root')).toBeNull();
    expect(await store.updateTask('other-root', { status: 'cancelled' })).toBe(false);
    await store.deleteTask('other-root');
    expect((await store.listTasks({ threadId: 'root' })).tasks).toEqual([]);
    expect(await store.getRunningCount()).toBe(0);
    expect(await store.getRunningCountByAgent('parent')).toBe(0);
    await expect(store.createTask(task('foreign-create'))).rejects.toThrow(/owner/);
    await expect(
      store.createTask({ ...task('replayed-write'), maxRetries: 1, threadId: 'root-b' })
    ).rejects.toThrow(/retries/);
    await expect(store.updateTask('own-root', { maxRetries: 1 })).rejects.toThrow(/retries/);
    await store.deleteTasks({ threadId: 'root' });
    await store.dangerouslyClearAll();
    expect(await global.getTask('other-root')).toMatchObject({ status: 'running' });
  } finally {
    await host.shutdown();
  }
});

it('returns ordered pages with the complete total, including an empty page and JSON null outcomes', async () => {
  const store = await backing(database);
  for (const id of ['c', 'a', 'b']) {
    await store.createTask(task(id));
  }
  await store.updateTask('b', { result: null, status: 'completed' });
  const page = await store.listTasks({ page: 1, perPage: 1 });
  expect(page.total).toBe(3);
  expect(page.tasks.map((task) => task.id)).toEqual(['b']);
  expect(page.tasks[0]).toHaveProperty('result', null);
  expect(await store.listTasks({ page: 3, perPage: 1 })).toEqual({ tasks: [], total: 3 });
  expect((await store.listTasks({ orderDirection: 'desc' })).tasks.map((task) => task.id)).toEqual([
    'c',
    'b',
    'a',
  ]);
});

it('rejects unbounded or extended scoped task timeouts before persistence', async () => {
  const result = await createPgliteMastraMemory({
    backgroundTaskScope: { resourceId: 'owner', threadId: 'root' },
    database: port(database),
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const store = await result.storage.getStore('backgroundTasks');
  if (!store) {
    throw new Error('Missing native background storage');
  }
  for (const timeoutMs of [0, 300_001, 1.5]) {
    await expect(store.createTask({ ...task('bounded-task'), timeoutMs })).rejects.toThrow(
      'Background task timeout'
    );
  }
  expect(await store.getTask('bounded-task')).toBeNull();
  await store.createTask({ ...task('bounded-task'), timeoutMs: 300_000 });
  await expect(store.updateTask('bounded-task', { timeoutMs: 300_001 })).rejects.toThrow(
    'Background task timeout'
  );
  expect(await store.getTask('bounded-task')).toMatchObject({ timeoutMs: 300_000 });
});
