import { McpTaskRepository } from '@brainstrike/db';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpTaskLifecycle,
  McpTaskLifecycleStoppedError,
  type McpTaskPollingClient,
} from '../mcp/tasks-lifecycle';

const AUTHORITY_INPUT = {
  connectionGeneration: 1,
  principalId: 'principal-1',
  resource: 'https://tasks.example.com/mcp',
  runtimeId: 'runtime-handle-spec',
  serverId: 'tasks',
} as const;

let db: PGlite | undefined;

async function openDb(): Promise<PGlite> {
  db = await createMigratedTestDb();
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
    const authority = await repository.openAuthority(AUTHORITY_INPUT);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client,
      onUpdate: () => undefined,
      repository,
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
    expect(lifecycle.snapshot()).toMatchObject({ activeTasks: 0, pendingCreates: 0, timers: 0 });
    await lifecycle.stop('disconnect');
  });

  it('reports a late or unknown notification instead of throwing, and guards track() before writing', async () => {
    const database = await openDb();
    const repository = new McpTaskRepository(database);
    const createSpy = vi.spyOn(repository, 'create');
    const gate = Promise.withResolvers<GetTaskResult>();
    const requestExtension = vi.fn(() => gate.promise);
    const authority = await repository.openAuthority(AUTHORITY_INPUT);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension } as unknown as McpTaskPollingClient,
      onUpdate: () => undefined,
      repository,
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

  function workingHandle(taskId: string): Parameters<McpTaskLifecycle['track']>[0] {
    return {
      createdAt: '2026-09-02T04:00:00.000Z',
      lastUpdatedAt: '2026-09-02T04:00:00.000Z',
      resultType: 'task',
      status: 'working',
      taskId,
      ttlMs: null,
    } as Parameters<McpTaskLifecycle['track']>[0];
  }

  it('keeps the authority epoch live across a disconnect so the next connect recovers the handle', async () => {
    const database = await openDb();
    const repository = new McpTaskRepository(database);
    const authority = await repository.openAuthority(AUTHORITY_INPUT);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))) },
      onUpdate: () => undefined,
      repository,
    });
    const tracked = await lifecycle.track(workingHandle('task-3'));
    await lifecycle.stop('disconnect');
    await expect(tracked.settled).rejects.toMatchObject({ reason: 'disconnect' });

    const rebound = await repository.openAuthority(AUTHORITY_INPUT);
    expect(rebound.authorityEpoch).toBe(authority.authorityEpoch);
    const recovered = new McpTaskLifecycle({
      authority: rebound,
      client: { requestExtension: vi.fn(async () => detailedCompleted('task-3')) },
      onUpdate: () => undefined,
      repository,
    });
    const handles = await recovered.recover();
    expect(handles.map((handle) => handle.record.taskId)).toEqual(['task-3']);
    await expect(handles[0]?.settled).resolves.toMatchObject({ status: 'completed' });
    await recovered.stop('closed');
  });

  it('retires the epoch only for server removal, retrying a failed retirement after the drain settled', async () => {
    const database = await openDb();
    const repository = new McpTaskRepository(database);
    const authority = await repository.openAuthority(AUTHORITY_INPUT);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))) },
      onUpdate: () => undefined,
      repository,
    });
    const tracked = await lifecycle.track(workingHandle('task-4'));
    const retire = vi
      .spyOn(repository, 'retireAuthority')
      .mockRejectedValueOnce(new Error('database is closed'));

    await expect(lifecycle.stop('server-removed')).rejects.toThrow('database is closed');
    await expect(tracked.settled).rejects.toMatchObject({ reason: 'server-removed' });
    expect(lifecycle.snapshot()).toMatchObject({ activeTasks: 0, pendingCreates: 0, timers: 0 });
    // A stopped lifecycle rejects track() instead of throwing synchronously.
    await expect(lifecycle.track(workingHandle('task-5'))).rejects.toBeInstanceOf(
      McpTaskLifecycleStoppedError
    );

    await lifecycle.stop('server-removed');
    expect(retire).toHaveBeenCalledTimes(2);
    const next = await repository.openAuthority(AUTHORITY_INPUT);
    expect(next.authorityEpoch).not.toBe(authority.authorityEpoch);
    expect(await repository.listActive(next)).toEqual([]);
  });
});
