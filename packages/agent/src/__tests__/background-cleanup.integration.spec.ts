import { setImmediate as nextTurn } from 'node:timers/promises';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { Mastra } from '@mastra/core/mastra';
import { expect, it } from 'vitest';
import {
  createPgliteMastraMemory,
  MASTRA_WORKFLOW_TABLE,
  type PgliteDatabase,
} from '../pglite-mastra-memory';

it('joins native workflow deletion before shutdown acknowledges completion', async () => {
  const database = await createEnginePglite();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const adapter: PgliteDatabase = {
    exec: (query) => database.exec(query),
    async query(query, values) {
      if (!query.startsWith(`DELETE FROM ${MASTRA_WORKFLOW_TABLE} WHERE`)) {
        return await database.query(query, values ? [...values] : undefined);
      }
      entered.resolve();
      await release.promise;
      try {
        return await database.query(query, values ? [...values] : undefined);
      } finally {
        finished.resolve();
      }
    },
    transaction: (operation) =>
      database.transaction((tx) =>
        operation({
          exec: (query) => tx.exec(query),
          query: (query, values) => tx.query(query, values ? [...values] : undefined),
        })
      ),
  };
  const backing = await createPgliteMastraMemory({ database: adapter });
  const host = new Mastra({
    backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
    logger: false,
    storage: backing.storage,
  });
  const manager = host.backgroundTaskManager;
  if (!manager) {
    throw new Error('Missing manager');
  }
  let shutdown: Promise<void> | undefined;
  try {
    await manager.init(host.pubsub);
    const { task } = await manager.enqueue(
      {
        agentId: 'owner',
        args: {},
        runId: 'run',
        toolCallId: 'call',
        toolName: 'work',
      },
      { executor: { execute: async () => ({ done: true }) } }
    );
    await entered.promise;
    expect((await manager.getTask(task.id))?.status).toBe('completed');
    let acknowledged = false;
    shutdown = host.shutdown().then(() => {
      acknowledged = true;
    });
    await nextTurn();
    await nextTurn();
    expect(
      acknowledged,
      'Native shutdown must join the workflow delete before the host can close storage'
    ).toBe(false);
    release.resolve();
    await shutdown;
    await finished.promise;
  } finally {
    release.resolve();
    await finished.promise;
    await (shutdown ?? host.shutdown());
    await database.close();
  }
});

it('returns direct deletion errors and leaves the borrowed database usable', async () => {
  const database = await createEnginePglite();
  const failure = new Error('Injected cleanup failure');
  const adapter: PgliteDatabase = {
    exec: (query) => database.exec(query),
    query: (query, values) => {
      if (query.startsWith(`DELETE FROM ${MASTRA_WORKFLOW_TABLE} WHERE`)) {
        return Promise.reject(failure);
      }
      return database.query(query, values ? [...values] : undefined);
    },
  };
  try {
    const backing = await createPgliteMastraMemory({ database: adapter });
    await expect(
      backing.workflows.deleteWorkflowRunById({
        runId: 'failed-delete',
        workflowName: 'test',
      })
    ).rejects.toBe(failure);
    expect((await database.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
  } finally {
    await database.close();
  }
});

it('reports native cleanup failure to the shutdown owner without an orphan rejection', async () => {
  const database = await createEnginePglite();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error('Native workflow cleanup failure');
  const adapter: PgliteDatabase = {
    exec: (query) => database.exec(query),
    async query(query, values) {
      if (query.startsWith(`DELETE FROM ${MASTRA_WORKFLOW_TABLE} WHERE`)) {
        entered.resolve();
        await release.promise;
        throw failure;
      }
      return await database.query(query, values ? [...values] : undefined);
    },
    transaction: (operation) =>
      database.transaction((tx) =>
        operation({
          exec: (query) => tx.exec(query),
          query: (query, values) => tx.query(query, values ? [...values] : undefined),
        })
      ),
  };
  const backing = await createPgliteMastraMemory({ database: adapter });
  const host = new Mastra({
    backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
    logger: false,
    storage: backing.storage,
  });
  const manager = host.backgroundTaskManager;
  if (!manager) {
    throw new Error('Missing manager');
  }
  let shutdown: Promise<unknown> | undefined;
  try {
    await manager.init(host.pubsub);
    await manager.enqueue(
      {
        agentId: 'owner',
        args: {},
        runId: 'run',
        toolCallId: 'call',
        toolName: 'work',
      },
      { executor: { execute: async () => ({ done: true }) } }
    );
    await entered.promise;
    shutdown = host.shutdown().then(
      () => undefined,
      (error: unknown) => error
    );
    release.resolve();
    expect(await shutdown).toMatchObject({ errors: [failure] });
    await expect(manager.shutdown()).rejects.toMatchObject({ errors: [failure] });
    expect((await database.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
    // Let the runner observe any unhandled rejection from the native caller.
    // No process listener is installed to suppress it.
    await nextTurn();
  } finally {
    release.resolve();
    await (shutdown ?? host.shutdown().catch((error: unknown) => error));
    await database.close();
  }
});
