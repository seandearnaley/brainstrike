import { McpTaskRepository, MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpTaskLifecycle, type McpTaskPollingClient } from '../mcp/tasks-lifecycle';

const SCOPE = {
  generation: 1,
  principalId: 'principal-1',
  resource: 'https://tasks.example.com/mcp',
  serverId: 'tasks',
} as const;

let db: PGlite | undefined;

async function openDb(): Promise<PGlite> {
  db = await wasmLoader.createPGlite('memory://');
  const runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations);
  return db;
}

afterEach(async () => {
  await db?.close();
  db = undefined;
});

function detailedCompleted(taskId: string): GetTaskResult {
  return {
    createdAt: '2026-09-02T04:00:00.000Z',
    lastUpdatedAt: '2026-09-02T04:00:01.000Z',
    result: { answer: 42 },
    resultType: 'complete',
    status: 'completed',
    taskId,
    ttlMs: null,
  } as GetTaskResult;
}

describe('MCP task lifecycle handles (review of #2915)', () => {
  it('persists a detail-less completed create result and fetches its detail at once', async () => {
    const database = await openDb();
    const repository = new McpTaskRepository(database);
    const requestExtension = vi.fn(async () => detailedCompleted('task-1'));
    const client = { requestExtension } as unknown as McpTaskPollingClient;
    const lifecycle = new McpTaskLifecycle({
      client,
      currentGeneration: () => SCOPE.generation,
      onUpdate: () => undefined,
      repository,
      scope: SCOPE,
    });

    const tracked = await lifecycle.track({
      createdAt: '2026-09-02T04:00:00.000Z',
      lastUpdatedAt: '2026-09-02T04:00:00.000Z',
      resultType: 'task',
      status: 'completed',
      taskId: 'task-1',
      ttlMs: null,
    } as Parameters<McpTaskLifecycle['track']>[0]);

    expect(tracked.record.status).toBe('working');
    expect(tracked.record.inputMetadata).toMatchObject({
      detail: 'pending',
      remoteStatus: 'completed',
    });
    const settled = await tracked.settled;
    expect(settled.status).toBe('completed');
    expect(settled.resultMetadata).toMatchObject({ result: { answer: 42 } });
    expect(requestExtension).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot()).toMatchObject({ activeTasks: 0, timers: 0 });
    await lifecycle.stop('disconnect');
  });

  it('reports a late or unknown notification instead of throwing, and guards track() before writing', async () => {
    const database = await openDb();
    const repository = new McpTaskRepository(database);
    const createSpy = vi.spyOn(repository, 'create');
    const gate = Promise.withResolvers<GetTaskResult>();
    const requestExtension = vi.fn(() => gate.promise);
    const lifecycle = new McpTaskLifecycle({
      client: { requestExtension } as unknown as McpTaskPollingClient,
      currentGeneration: () => SCOPE.generation,
      onUpdate: () => undefined,
      repository,
      scope: SCOPE,
    });
    expect(lifecycle.wake('never-tracked')).toBe(false);

    const handle = {
      createdAt: '2026-09-02T04:00:00.000Z',
      lastUpdatedAt: '2026-09-02T04:00:00.000Z',
      resultType: 'task',
      status: 'working',
      taskId: 'task-2',
      ttlMs: null,
    } as Parameters<McpTaskLifecycle['track']>[0];
    const tracked = await lifecycle.track(handle);
    expect(createSpy).toHaveBeenCalledTimes(1);
    await expect(lifecycle.track(handle)).rejects.toThrow(/already tracked/u);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(lifecycle.wake('task-2')).toBe(true);

    gate.resolve(detailedCompleted('task-2'));
    await expect(tracked.settled).resolves.toMatchObject({ status: 'completed' });
    expect(lifecycle.wake('task-2')).toBe(false);
    await lifecycle.stop('disconnect');
  });
});
