import { McpTaskRepository } from '@brainstrike/db';
import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner, migrations } from '../../../db/src/migrations/index.js';
import { wasmLoader } from '../../../db/src/wasm-loader.js';
import {
  DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
  McpTaskLifecycle,
  type McpTaskLifecycleStopReason,
  McpTaskObservationError,
  type McpTaskPollingClient,
} from '../mcp/tasks-lifecycle.js';

const CREATED_AT = '2026-09-01T05:00:00.000Z';
const scope = {
  generation: 9,
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  serverId: 'linear',
} as const;

function task(taskId: string, overrides: { pollIntervalMs?: number; ttlMs?: number | null } = {}) {
  return {
    createdAt: CREATED_AT,
    lastUpdatedAt: CREATED_AT,
    pollIntervalMs: overrides.pollIntervalMs ?? 100,
    resultType: 'task' as const,
    status: 'working' as const,
    taskId,
    ttlMs: overrides.ttlMs === undefined ? 10_000 : overrides.ttlMs,
  };
}

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

async function openDatabase(): Promise<PGlite> {
  const db = await wasmLoader.createPGlite('memory://');
  const runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations);
  return db;
}

function expectNoLifecycleLeaks(lifecycle: McpTaskLifecycle): void {
  expect(lifecycle.snapshot()).toEqual({
    activePolls: 0,
    activeTasks: 0,
    queuedPolls: 0,
    timers: 0,
  });
}

describe('McpTaskLifecycle exit fencing', () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await db?.close();
  });

  it('stops pending timers for disconnect, reset, server removal, and terminal close', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const reasons = [
      'disconnect',
      'reset',
      'server-removed',
      'closed',
    ] as const satisfies readonly McpTaskLifecycleStopReason[];

    for (const reason of reasons) {
      const lifecycle = new McpTaskLifecycle({
        client: {
          requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
        },
        currentGeneration: () => scope.generation,
        onUpdate: vi.fn(),
        repository,
        scope,
      });
      const tracked = await lifecycle.track(task(`task-${reason}`));
      await lifecycle.stop(reason);
      await expect(tracked.settled).rejects.toMatchObject({ reason });
      expectNoLifecycleLeaks(lifecycle);
    }
  });

  it('stops one task on caller cancellation without deleting its durable handle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const lifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      currentGeneration: () => scope.generation,
      onUpdate: vi.fn(),
      repository,
      scope,
    });
    const controller = new AbortController();
    const tracked = await lifecycle.track(task('task-cancelled-by-caller'), controller.signal);
    const reason = new Error('caller cancelled');

    controller.abort(reason);

    await expect(tracked.settled).rejects.toBe(reason);
    await expect(
      repository.get({ ...scope, taskId: 'task-cancelled-by-caller' })
    ).resolves.toMatchObject({ status: 'working' });
    expectNoLifecycleLeaks(lifecycle);
  });

  it('uses the task TTL as a hard lifetime backstop and never polls after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    let polls = 0;
    const client: McpTaskPollingClient = {
      requestExtension: vi.fn(async (_contract, params): Promise<GetTaskResult> => {
        polls += 1;
        return {
          ...task(params.taskId, { ttlMs: 250 }),
          lastUpdatedAt: new Date(Date.now()).toISOString(),
          resultType: 'complete',
        };
      }),
    };
    const lifecycle = new McpTaskLifecycle({
      client,
      currentGeneration: () => scope.generation,
      limits: DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
      onUpdate: vi.fn(),
      repository: new McpTaskRepository(db),
      scope,
    });
    const tracked = await lifecycle.track(task('task-expiring', { ttlMs: 250 }));
    const settlement = expect(tracked.settled).rejects.toThrow(/bounded lifetime/u);

    await vi.advanceTimersByTimeAsync(200);
    expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(50);

    await settlement;
    expect(polls).toBe(2);
    expectNoLifecycleLeaks(lifecycle);
  });

  it('rejects a mismatched task response without publishing or mutating the durable handle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const onUpdate = vi.fn();
    const lifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(
          async (): Promise<GetTaskResult> => ({
            createdAt: CREATED_AT,
            lastUpdatedAt: '2026-09-01T05:00:00.100Z',
            result: { answer: 42 },
            resultType: 'complete',
            status: 'completed',
            taskId: 'attacker-task',
            ttlMs: 10_000,
          })
        ),
      },
      currentGeneration: () => scope.generation,
      onUpdate,
      repository,
      scope,
    });
    const tracked = await lifecycle.track(task('expected-task'));
    const settlement = expect(tracked.settled).rejects.toThrow(/identity mismatch/u);

    await vi.advanceTimersByTimeAsync(100);

    await settlement;
    await expect(repository.get({ ...scope, taskId: 'expected-task' })).resolves.toMatchObject({
      status: 'working',
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expectNoLifecycleLeaks(lifecycle);
  });

  it('exposes bounded transport exhaustion as the terminal observation failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const transportFailure = new Error('transport unavailable');
    const requestExtension = vi.fn(() => Promise.reject(transportFailure));
    const repository = new McpTaskRepository(db);
    const onUpdate = vi.fn();
    const lifecycle = new McpTaskLifecycle({
      client: { requestExtension },
      currentGeneration: () => scope.generation,
      limits: {
        ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
        initialPollMs: 25,
        maxBackoffMs: 100,
        minimumPollMs: 10,
      },
      onUpdate,
      repository,
      scope,
    });
    const tracked = await lifecycle.track({
      ...task('task-exhausted'),
      pollIntervalMs: undefined,
    });

    await vi.advanceTimersByTimeAsync(175);

    const failure = await tracked.settled.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpTaskObservationError);
    expect(failure).toMatchObject({
      cause: transportFailure,
      failures: 3,
      taskId: 'task-exhausted',
    });
    expect(requestExtension).toHaveBeenCalledTimes(3);
    expect(onUpdate).not.toHaveBeenCalled();
    await expect(repository.get({ ...scope, taskId: 'task-exhausted' })).resolves.toMatchObject({
      status: 'working',
    });
    expectNoLifecycleLeaks(lifecycle);
  });

  it('rejects invalid server timing before persistence instead of silently coercing it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const lifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      currentGeneration: () => scope.generation,
      onUpdate: vi.fn(),
      repository,
      scope,
    });

    await expect(lifecycle.track(task('invalid-timing', { pollIntervalMs: -1 }))).rejects.toThrow(
      /pollIntervalMs/u
    );
    await expect(repository.get({ ...scope, taskId: 'invalid-timing' })).resolves.toBeNull();
    expectNoLifecycleLeaks(lifecycle);
  });

  it('rejects a terminal creation seed that omits its canonical result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const lifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      currentGeneration: () => scope.generation,
      onUpdate: vi.fn(),
      repository,
      scope,
    });

    await expect(
      lifecycle.track({ ...task('invalid-terminal'), status: 'completed' })
    ).rejects.toThrow(/must include its result/u);
    await expect(repository.get({ ...scope, taskId: 'invalid-terminal' })).resolves.toBeNull();
    expectNoLifecycleLeaks(lifecycle);
  });

  it('rejects immutable creation-time drift before persistence or publication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const onUpdate = vi.fn();
    const lifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(
          async (): Promise<GetTaskResult> => ({
            ...task('task-time-drift'),
            createdAt: '2026-09-01T05:00:01.000Z',
            lastUpdatedAt: '2026-09-01T05:00:01.100Z',
            result: { answer: 42 },
            resultType: 'complete',
            status: 'completed',
          })
        ),
      },
      currentGeneration: () => scope.generation,
      onUpdate,
      repository,
      scope,
    });
    const tracked = await lifecycle.track(task('task-time-drift'));
    const settlement = tracked.settled.then(
      () => undefined,
      (error: unknown) => error
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(String(await settlement)).toMatch(/createdAt changed/u);
    await expect(repository.get({ ...scope, taskId: 'task-time-drift' })).resolves.toMatchObject({
      status: 'working',
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expectNoLifecycleLeaks(lifecycle);
  });

  it('clears transient input and status metadata when the task becomes terminal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    let polls = 0;
    const lifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(async (): Promise<GetTaskResult> => {
          polls += 1;
          if (polls === 1) {
            return {
              ...task('task-input'),
              inputRequests: {},
              lastUpdatedAt: '2026-09-01T05:00:00.100Z',
              resultType: 'complete',
              status: 'input_required',
              statusMessage: 'waiting for input',
            };
          }
          return {
            createdAt: CREATED_AT,
            lastUpdatedAt: '2026-09-01T05:00:00.200Z',
            result: { answer: 42 },
            resultType: 'complete',
            status: 'completed',
            taskId: 'task-input',
            ttlMs: 10_000,
          };
        }),
      },
      currentGeneration: () => scope.generation,
      onUpdate: vi.fn(),
      repository: new McpTaskRepository(db),
      scope,
    });
    const tracked = await lifecycle.track(task('task-input'));

    await vi.advanceTimersByTimeAsync(200);

    await expect(tracked.settled).resolves.toMatchObject({
      inputMetadata: null,
      status: 'completed',
      statusMessage: null,
    });
    expectNoLifecycleLeaks(lifecycle);
  });

  it('does not expose a handle when reset wins the persistence race', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const insertStarted = deferred<void>();
    const releaseInsert = deferred<void>();
    const repository = new McpTaskRepository({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO brainstrike_mcp_tasks')) {
          insertStarted.resolve(undefined);
          await releaseInsert.promise;
        }
        if (!db) {
          throw new Error('Test database is not open.');
        }
        return await db.query(sql, params);
      },
    });
    const lifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      currentGeneration: () => scope.generation,
      onUpdate: vi.fn(),
      repository,
      scope,
    });

    const tracking = lifecycle.track(task('task-reset-race'));
    await insertStarted.promise;
    const stopping = lifecycle.stop('reset');
    releaseInsert.resolve(undefined);

    await expect(tracking).rejects.toMatchObject({ reason: 'reset' });
    await stopping;
    expectNoLifecycleLeaks(lifecycle);
  });

  it('validates every durable recovery row before starting any poller', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    await repository.create(
      {
        ...scope,
        inputMetadata: {
          lifecycle: {
            createdAt: CREATED_AT,
            lastUpdatedAt: CREATED_AT,
            pollIntervalMs: 100,
            ttlMs: 10_000,
          },
        },
        status: 'working',
        taskId: 'a-valid',
      },
      { currentGeneration: scope.generation }
    );
    await repository.create(
      {
        ...scope,
        status: 'working',
        taskId: 'b-corrupt',
      },
      { currentGeneration: scope.generation }
    );
    const lifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      currentGeneration: () => scope.generation,
      onUpdate: vi.fn(),
      repository,
      scope,
    });

    try {
      await expect(lifecycle.recover()).rejects.toThrow(/no durable lifecycle timing/u);
      expectNoLifecycleLeaks(lifecycle);
    } finally {
      await lifecycle.stop('closed');
    }
  });

  it('keeps the local lifetime bound across lifecycle reconstruction when TTL is null', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const firstLifecycle = new McpTaskLifecycle({
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      currentGeneration: () => scope.generation,
      limits: { ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS, maxLifetimeMs: 250 },
      onUpdate: vi.fn(),
      repository,
      scope,
    });
    const original = await firstLifecycle.track(task('task-null-ttl', { ttlMs: null }));
    await firstLifecycle.stop('restart');
    await expect(original.settled).rejects.toMatchObject({ reason: 'restart' });
    await vi.advanceTimersByTimeAsync(200);

    const requestExtension = vi.fn(() => Promise.reject(new Error('poll must not start')));
    const recoveredLifecycle = new McpTaskLifecycle({
      client: { requestExtension },
      currentGeneration: () => scope.generation,
      limits: { ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS, maxLifetimeMs: 250 },
      onUpdate: vi.fn(),
      repository,
      scope,
    });
    const [recovered] = await recoveredLifecycle.recover();
    let failure: unknown;
    void recovered?.settled.catch((error: unknown) => {
      failure = error;
    });

    await vi.advanceTimersByTimeAsync(50);

    try {
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/bounded lifetime/u);
      expect(requestExtension).not.toHaveBeenCalled();
      expectNoLifecycleLeaks(recoveredLifecycle);
    } finally {
      await recoveredLifecycle.stop('closed');
    }
  });
});
