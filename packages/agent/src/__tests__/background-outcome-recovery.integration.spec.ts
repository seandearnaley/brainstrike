import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { Mastra } from '@mastra/core/mastra';
import { expect, it } from 'vitest';
import { repairBackgroundResults } from '../mastra/background-results';
import { createPgliteMastraMemory } from '../pglite-mastra-memory';

it.each(['completed', 'failed', 'timed_out'] as const)(
  'recovers an undelivered %s outcome without its retained parent message, exactly once',
  async (status) => {
    const database = await createEnginePglite();
    const scope = { resourceId: 'owner', threadId: 'root' };
    const backing = await createPgliteMastraMemory({
      backgroundTaskScope: scope,
      database: {
        exec: (sql) => database.exec(sql),
        query: (sql, values) => database.query(sql, values ? [...values] : undefined),
        transaction: (operation) =>
          database.transaction((tx) =>
            operation({
              exec: (sql) => tx.exec(sql),
              query: (sql, values) => tx.query(sql, values ? [...values] : undefined),
            })
          ),
      },
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
    const host = new Mastra({
      backgroundTasks: { enabled: true },
      logger: false,
      storage: backing.storage,
    });
    try {
      const manager = host.backgroundTaskManager;
      if (!manager) {
        throw new Error('Missing native manager');
      }
      await backing.memory.saveThread({
        thread: {
          createdAt: new Date(),
          id: scope.threadId,
          resourceId: scope.resourceId,
          title: 'Root',
          updatedAt: new Date(),
        },
      });
      const store = await manager.getStorage();
      await store.createTask({
        ...scope,
        agentId: 'parent',
        args: { prompt: 'Write once' },
        completedAt: new Date(),
        createdAt: new Date(),
        id: 'finished',
        maxRetries: 0,
        retryCount: 0,
        runId: 'native-run',
        status,
        timeoutMs: 30_000,
        toolCallId: 'native-call',
        toolName: 'agent-worker',
        ...(status === 'completed' ? { result: { written: true } } : {}),
      });
      expect(await repairBackgroundResults({ manager, memory: backing.memory, scope })).toEqual([
        'finished',
      ]);
      const saved = await backing.memory.recall({ ...scope, perPage: false });
      const invocation = saved.messages
        .flatMap((message) => message.content.parts)
        .find((part) => part.type === 'tool-invocation');
      expect(invocation).toMatchObject({
        toolInvocation: {
          args: { prompt: 'Write once' },
          state: status === 'completed' ? 'result' : 'output-error',
          toolCallId: 'native-call',
        },
        type: 'tool-invocation',
      });
      if (status !== 'completed') {
        expect(JSON.stringify(invocation)).toContain(
          status === 'timed_out' ? 'timed out' : 'without persisted error details'
        );
      }
      expect(JSON.stringify(saved.messages)).toContain('work was not executed again');
      await database.query('DELETE FROM mastra_messages WHERE thread_id = $1', [scope.threadId]);
      expect(await repairBackgroundResults({ manager, memory: backing.memory, scope })).toEqual([]);
      expect(await manager.getTask('finished')).toMatchObject({ status });
      const restored = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
      try {
        expect(
          (
            await restored.query(
              'SELECT delivered_at IS NOT NULL AS delivered FROM mastra_background_tasks'
            )
          ).rows
        ).toEqual([{ delivered: true }]);
      } finally {
        await restored.close();
      }
    } finally {
      await host.shutdown();
      await database.close();
    }
  }
);
