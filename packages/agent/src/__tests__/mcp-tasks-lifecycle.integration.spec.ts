import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  McpTaskAuthorityLease,
  McpTaskRecord,
} from '@brainstrike/assistant-contract/mcp-task-store';
import { McpTaskRepository, MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_TASKS_GET_REQUEST_CONTRACT } from '../mcp/tasks-extension.js';
import {
  DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
  McpTaskLifecycle,
  type McpTaskPollingClient,
} from '../mcp/tasks-lifecycle.js';
import { McpTaskObservationPort } from '../mcp/tasks-observation.js';

const consumerErrorSink = (taskId: string, error: unknown): void => {
  throw new Error(`unexpected consumer error for ${taskId}: ${String(error)}`);
};

const authorityInput = {
  connectionGeneration: 7,
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  runtimeId: 'desktop-runtime-a',
  serverId: 'linear',
} as const;

function taskIdentity(authority: McpTaskAuthorityLease, taskId: string) {
  return {
    authorityEpoch: authority.authorityEpoch,
    principalId: authority.principalId,
    resource: authority.resource,
    serverId: authority.serverId,
    taskId,
  } as const;
}

const createdTask = {
  createdAt: '2026-09-01T04:00:00.000Z',
  lastUpdatedAt: '2026-09-01T04:00:00.000Z',
  pollIntervalMs: 100,
  resultType: 'task',
  status: 'working',
  taskId: 'task-1',
  ttlMs: 10_000,
} as const;

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) {
        throw new Error('Deferred promise was not initialized.');
      }
      resolvePromise(value);
    },
  };
}

function completedTask(taskId: string, lastUpdatedAt: string): GetTaskResult {
  return {
    createdAt: createdTask.createdAt,
    lastUpdatedAt,
    result: { taskId },
    resultType: 'complete',
    status: 'completed',
    taskId,
    ttlMs: createdTask.ttlMs,
  };
}

async function openDatabase(): Promise<PGlite> {
  return await createMigratedTestDb();
}

/** The restart case reopens a real on-disk directory, so it migrates cold. */
async function openDatabaseAt(dataDir: string): Promise<PGlite> {
  const db = await wasmLoader.createPGlite(dataDir);
  const runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations);
  return db;
}

describe('McpTaskLifecycle', () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await db?.close();
  });

  it('persists a returned handle before exposure and publishes only a durable terminal result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const updates: string[] = [];
    const client: McpTaskPollingClient = {
      requestExtension: vi.fn(async (contract, params, options): Promise<GetTaskResult> => {
        expect(contract).toBe(MCP_TASKS_GET_REQUEST_CONTRACT);
        expect(params).toEqual({ taskId: createdTask.taskId });
        expect(options?.signal.aborted).toBe(false);
        return {
          createdAt: createdTask.createdAt,
          lastUpdatedAt: '2026-09-01T04:00:00.100Z',
          result: { answer: 42 },
          resultType: 'complete',
          status: 'completed',
          taskId: createdTask.taskId,
          ttlMs: 10_000,
        };
      }),
    };
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client,
      limits: { ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS, initialPollMs: 25 },
      onUpdate: (record) => {
        updates.push(record.status);
      },
      repository,
    });

    const tracked = await lifecycle.track(createdTask);
    await expect(
      repository.get(taskIdentity(authority, createdTask.taskId))
    ).resolves.toMatchObject({
      status: 'working',
      taskId: createdTask.taskId,
    });
    expect(updates).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    await expect(tracked.settled).resolves.toMatchObject({
      resultMetadata: { result: { answer: 42 } },
      status: 'completed',
    });
    expect(updates).toEqual(['completed']);
    expect(lifecycle.snapshot()).toEqual({
      activePolls: 0,
      activeTasks: 0,
      pendingCreates: 0,
      queuedPolls: 0,
      timers: 0,
    });
  });

  it('publishes a persisted update before the interaction consumer parks on its input', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const identity = taskIdentity(authority, createdTask.taskId);
    const order: string[] = [];
    const observing = Promise.withResolvers<void>();
    // The user has not answered: the consumer stays parked on the input.
    const unanswered = new Promise<never>(() => undefined);
    const observationPort = new McpTaskObservationPort({ onConsumerError: consumerErrorSink });
    observationPort.subscribe({
      fail: vi.fn(),
      observe: async (task) => {
        order.push(`observe:${task.status}`);
        observing.resolve();
        await unanswered;
      },
    });
    const inputRequired: GetTaskResult = {
      createdAt: createdTask.createdAt,
      inputRequests: {
        approval: {
          method: 'elicitation/create',
          params: {
            message: 'Approve?',
            mode: 'form',
            requestedSchema: { properties: {}, type: 'object' },
          },
        },
      },
      lastUpdatedAt: '2026-09-01T04:00:00.100Z',
      resultType: 'complete',
      status: 'input_required',
      taskId: createdTask.taskId,
      ttlMs: createdTask.ttlMs,
    };
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension: vi.fn(async (): Promise<GetTaskResult> => inputRequired) },
      observationPort,
      onUpdate: async (record) => {
        // Persist before publish still holds: the published record is the durable row.
        await expect(repository.get(identity)).resolves.toEqual(record);
        order.push(`update:${record.status}`);
      },
      repository,
    });
    const tracked = await lifecycle.track(createdTask);

    await vi.advanceTimersByTimeAsync(createdTask.pollIntervalMs);
    await observing.promise;
    expect(order).toEqual(['update:input_required', 'observe:input_required']);

    await lifecycle.stop('closed');
    await expect(tracked.settled).rejects.toMatchObject({ reason: 'closed' });
    expect(lifecycle.snapshot()).toEqual({
      activePolls: 0,
      activeTasks: 0,
      pendingCreates: 0,
      queuedPolls: 0,
      timers: 0,
    });
  });

  it('coalesces notification wakeups into one lifecycle-owned poll and publishes after persistence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const observationPort = new McpTaskObservationPort({ onConsumerError: consumerErrorSink });
    const observed = vi.fn(async (task: GetTaskResult) => {
      await expect(repository.get(taskIdentity(authority, task.taskId))).resolves.toMatchObject({
        status: task.status,
      });
    });
    observationPort.subscribe({ fail: vi.fn(), observe: observed });
    const requestExtension = vi.fn(
      async (): Promise<GetTaskResult> => completedTask('task-wake', '2026-09-01T04:00:00.100Z')
    );
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      observationPort,
      onUpdate: vi.fn(),
      repository,
    });
    const tracked = await lifecycle.track({
      ...createdTask,
      pollIntervalMs: 10_000,
      taskId: 'task-wake',
    });

    observationPort.requestPoll('task-wake');
    observationPort.requestPoll('task-wake');
    await vi.advanceTimersByTimeAsync(0);

    await expect(tracked.settled).resolves.toMatchObject({ status: 'completed' });
    expect(requestExtension).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot()).toEqual({
      activePolls: 0,
      activeTasks: 0,
      pendingCreates: 0,
      queuedPolls: 0,
      timers: 0,
    });
  });

  it('recovers the exact principal task from a real database restart at its durable cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pglite-agent-mcp-task-restart-'));
    db = await openDatabaseAt(dataDir);
    const firstRepository = new McpTaskRepository(db);
    const firstAuthority = await firstRepository.openAuthority(authorityInput);
    const firstLifecycle = new McpTaskLifecycle({
      authority: firstAuthority,
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('restart happened before poll'))),
      },
      onUpdate: vi.fn(),
      repository: firstRepository,
    });

    const beforeRestart = await firstLifecycle.track(createdTask);
    expect(beforeRestart.record.inputMetadata).toEqual({
      lifecycle: {
        createdAt: createdTask.createdAt,
        lastUpdatedAt: createdTask.lastUpdatedAt,
        pollIntervalMs: createdTask.pollIntervalMs,
        ttlMs: createdTask.ttlMs,
      },
    });
    await firstLifecycle.stop('restart');
    await expect(beforeRestart.settled).rejects.toMatchObject({ reason: 'restart' });
    const otherPrincipalAuthority = await firstRepository.openAuthority({
      ...authorityInput,
      principalId: 'other',
    });
    await firstRepository.create(
      {
        ...taskIdentity(otherPrincipalAuthority, 'other-principal'),
        status: 'working',
      },
      otherPrincipalAuthority
    );
    await db.close();

    db = await openDatabaseAt(dataDir);
    const requestExtension = vi.fn(
      async (): Promise<GetTaskResult> => ({
        createdAt: createdTask.createdAt,
        lastUpdatedAt: '2026-09-01T04:00:00.100Z',
        result: { restarted: true },
        resultType: 'complete',
        status: 'completed',
        taskId: createdTask.taskId,
        ttlMs: createdTask.ttlMs,
      })
    );
    const restartedRepository = new McpTaskRepository(db);
    const reboundAuthority = await restartedRepository.openAuthority({
      ...authorityInput,
      connectionGeneration: 1,
      runtimeId: 'desktop-runtime-b',
    });
    expect(reboundAuthority.authorityEpoch).toBe(firstAuthority.authorityEpoch);
    const recoveredLifecycle = new McpTaskLifecycle({
      authority: reboundAuthority,
      client: { requestExtension },
      onUpdate: vi.fn(),
      repository: restartedRepository,
    });

    const recovered = await recoveredLifecycle.recover();
    expect(recovered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(createdTask.pollIntervalMs - 1);
    expect(requestExtension).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(recovered[0]?.settled).resolves.toMatchObject({ status: 'completed' });
    expect(recoveredLifecycle.snapshot()).toEqual({
      activePolls: 0,
      activeTasks: 0,
      pendingCreates: 0,
      queuedPolls: 0,
      timers: 0,
    });
  });

  it('recovers idempotently: an already-tracked active task is reused, only untracked ones start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const polled: string[] = [];
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: vi.fn(async (_contract, params): Promise<GetTaskResult> => {
          const taskId = String((params as { taskId: string }).taskId);
          polled.push(taskId);
          return completedTask(taskId, '2026-09-01T04:00:00.100Z');
        }),
      },
      onUpdate: vi.fn(),
      repository,
    });
    // One task is live in this lifecycle; a second active row exists durably
    // but has no poller here (e.g. its earlier poll failed, or another runtime wrote it).
    const live = await lifecycle.track(createdTask);
    const orphan = await repository.create(
      {
        ...taskIdentity(authority, 'task-orphan'),
        inputMetadata: {
          lifecycle: {
            createdAt: createdTask.createdAt,
            lastUpdatedAt: createdTask.lastUpdatedAt,
            pollIntervalMs: createdTask.pollIntervalMs,
            ttlMs: createdTask.ttlMs,
          },
        },
        status: 'working',
      },
      authority
    );
    expect(lifecycle.snapshot().activeTasks).toBe(1);

    const recovered = await lifecycle.recover();

    expect(recovered.map((tracked) => tracked.record.taskId).sort()).toEqual(
      [createdTask.taskId, orphan.taskId].sort()
    );
    const reused = recovered.find((tracked) => tracked.record.taskId === createdTask.taskId);
    expect(reused?.settled).toBe(live.settled);
    expect(lifecycle.snapshot().activeTasks).toBe(2);
    await vi.advanceTimersByTimeAsync(createdTask.pollIntervalMs);
    await expect(live.settled).resolves.toMatchObject({ status: 'completed' });
    const orphanTracked = recovered.find((tracked) => tracked.record.taskId === orphan.taskId);
    await expect(orphanTracked?.settled).resolves.toMatchObject({ status: 'completed' });
    // Exactly one poller per task: the live task was polled once, not twice.
    expect(polled.filter((taskId) => taskId === createdTask.taskId)).toHaveLength(1);
    expect(polled.filter((taskId) => taskId === orphan.taskId)).toHaveLength(1);
    expect(lifecycle.snapshot().activeTasks).toBe(0);
  });

  it('bounds concurrent polls and honors a changed server polling cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    db = await openDatabase();
    const requests = [
      deferred<GetTaskResult>(),
      deferred<GetTaskResult>(),
      deferred<GetTaskResult>(),
      deferred<GetTaskResult>(),
    ];
    let nextRequest = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const requestExtension = vi.fn((_contract, _params): Promise<GetTaskResult> => {
      const request = requests[nextRequest];
      nextRequest += 1;
      if (!request) {
        throw new Error('Unexpected extra poll.');
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return request.promise.finally(() => {
        inFlight -= 1;
      });
    });
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      limits: {
        ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
        maxConcurrentPolls: 2,
      },
      onUpdate: vi.fn(),
      repository,
    });
    const tracked = await Promise.all(
      ['task-a', 'task-b', 'task-c'].map((taskId) => lifecycle.track({ ...createdTask, taskId }))
    );

    await vi.advanceTimersByTimeAsync(createdTask.pollIntervalMs);
    expect(requestExtension).toHaveBeenCalledTimes(2);
    expect(lifecycle.snapshot()).toMatchObject({
      activePolls: 2,
      activeTasks: 3,
      queuedPolls: 1,
    });

    requests[0]?.resolve({
      ...createdTask,
      lastUpdatedAt: '2026-09-01T04:00:00.100Z',
      pollIntervalMs: 500,
      resultType: 'complete',
      status: 'working',
      taskId: 'task-a',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestExtension).toHaveBeenCalledTimes(3);
    requests[1]?.resolve(completedTask('task-b', '2026-09-01T04:00:00.100Z'));
    requests[2]?.resolve(completedTask('task-c', '2026-09-01T04:00:00.100Z'));
    await vi.advanceTimersByTimeAsync(499);
    expect(requestExtension).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestExtension).toHaveBeenCalledTimes(4);
    requests[3]?.resolve(completedTask('task-a', '2026-09-01T04:00:00.600Z'));

    await Promise.all(tracked.map(({ settled }) => settled));
    expect(maxInFlight).toBe(2);
    expect(lifecycle.snapshot()).toEqual({
      activePolls: 0,
      activeTasks: 0,
      pendingCreates: 0,
      queuedPolls: 0,
      timers: 0,
    });
  });

  it('uses bounded exponential backoff when the server omits a polling cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    db = await openDatabase();
    const pollTimes: number[] = [];
    const requestExtension = vi.fn(async (_contract, params): Promise<GetTaskResult> => {
      pollTimes.push(Date.now());
      if (pollTimes.length === 3) {
        return completedTask(String(params.taskId), new Date(Date.now()).toISOString());
      }
      return {
        createdAt: createdTask.createdAt,
        lastUpdatedAt: new Date(Date.now()).toISOString(),
        resultType: 'complete',
        status: 'working',
        taskId: String(params.taskId),
        ttlMs: createdTask.ttlMs,
      };
    });
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      limits: {
        ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
        initialPollMs: 25,
        maxBackoffMs: 100,
        minimumPollMs: 10,
      },
      onUpdate: vi.fn(),
      repository,
    });
    const tracked = await lifecycle.track({
      ...createdTask,
      pollIntervalMs: undefined,
      taskId: 'task-backoff',
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(requestExtension).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(requestExtension).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(requestExtension).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(tracked.settled).resolves.toMatchObject({ status: 'completed' });
    expect(pollTimes.map((time) => time - Date.parse(createdTask.createdAt))).toEqual([
      25, 75, 175,
    ]);
    expect(lifecycle.snapshot()).toEqual({
      activePolls: 0,
      activeTasks: 0,
      pendingCreates: 0,
      queuedPolls: 0,
      timers: 0,
    });
  });

  it('coalesces stale notifications into one immediate newer persisted poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    db = await openDatabase();
    const firstPoll = deferred<GetTaskResult>();
    const secondPoll = deferred<GetTaskResult>();
    const polls = [firstPoll, secondPoll];
    const requestExtension = vi.fn(() => {
      const poll = polls.shift();
      if (!poll) {
        throw new Error('Unexpected extra lifecycle poll.');
      }
      return poll.promise;
    });
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const publications: McpTaskRecord[] = [];
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      onUpdate: (record) => {
        publications.push(record);
      },
      repository,
    });
    const tracked = await lifecycle.track(createdTask);

    await vi.advanceTimersByTimeAsync(createdTask.pollIntervalMs);
    expect(requestExtension).toHaveBeenCalledOnce();
    const staleNotification = {
      ...createdTask,
      lastUpdatedAt: '2026-09-01T04:00:00.050Z',
      status: 'input_required' as const,
    };
    lifecycle.wake(staleNotification.taskId);
    lifecycle.wake(staleNotification.taskId);
    firstPoll.resolve({
      ...createdTask,
      lastUpdatedAt: '2026-09-01T04:00:00.100Z',
      pollIntervalMs: 1000,
      resultType: 'complete',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(requestExtension).toHaveBeenCalledTimes(2);
    expect(publications).toMatchObject([
      {
        inputMetadata: { lifecycle: { lastUpdatedAt: '2026-09-01T04:00:00.100Z' } },
        status: 'working',
      },
    ]);
    secondPoll.resolve(completedTask(createdTask.taskId, '2026-09-01T04:00:00.200Z'));
    await expect(tracked.settled).resolves.toMatchObject({ status: 'completed' });
    expect(publications).toMatchObject([
      {
        inputMetadata: { lifecycle: { lastUpdatedAt: '2026-09-01T04:00:00.100Z' } },
        status: 'working',
      },
      {
        resultMetadata: { lifecycle: { lastUpdatedAt: '2026-09-01T04:00:00.200Z' } },
        status: 'completed',
      },
    ]);
    expect(JSON.stringify(publications)).not.toContain(staleNotification.lastUpdatedAt);
    // A late notification for a settled task is ordinary MCP timing (review
    // of #2915): reported, never thrown.
    expect(lifecycle.wake(createdTask.taskId)).toBe(false);
  });

  it('fences an uncooperative in-flight poll immediately when the generation is replaced', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdTask.createdAt));
    db = await openDatabase();
    const request = deferred<GetTaskResult>();
    const onUpdate = vi.fn();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension: vi.fn(() => request.promise) },
      onUpdate,
      repository,
    });
    const tracked = await lifecycle.track(createdTask);
    await vi.advanceTimersByTimeAsync(createdTask.pollIntervalMs);
    expect(lifecycle.snapshot()).toMatchObject({ activePolls: 1, activeTasks: 1 });

    let stopped = false;
    const stop = lifecycle.stop('server-replaced').then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(stopped).toBe(true);
      await expect(tracked.settled).rejects.toMatchObject({ reason: 'server-replaced' });
      expect(onUpdate).not.toHaveBeenCalled();
      expect(lifecycle.snapshot()).toEqual({
        activePolls: 0,
        activeTasks: 0,
        pendingCreates: 0,
        queuedPolls: 0,
        timers: 0,
      });
    } finally {
      request.resolve(completedTask(createdTask.taskId, '2026-09-01T04:00:00.100Z'));
      await stop;
    }
  });
});
