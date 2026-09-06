import {
  type McpTaskAuthorityLease,
  McpTaskRepository,
  MigrationRunner,
  migrations,
  wasmLoader,
} from '@brainstrike/db';
import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpTaskInteraction } from '../mcp/tasks-interaction.js';
import {
  DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
  McpTaskLifecycle,
  type McpTaskLifecycleStopReason,
  type McpTaskPollingClient,
} from '../mcp/tasks-lifecycle.js';
import { McpTaskObservationError, McpTaskObservationPort } from '../mcp/tasks-observation.js';

const consumerErrorSink = (taskId: string, error: unknown): void => {
  throw new Error(`unexpected consumer error for ${taskId}: ${String(error)}`);
};

const CREATED_AT = '2026-09-01T05:00:00.000Z';
const authorityInput = {
  connectionGeneration: 9,
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
    pendingCreates: 0,
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

    for (const [index, reason] of reasons.entries()) {
      const authority = await repository.openAuthority({
        ...authorityInput,
        connectionGeneration: authorityInput.connectionGeneration + index,
      });
      const lifecycle = new McpTaskLifecycle({
        authority,
        client: {
          requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
        },
        onUpdate: vi.fn(),
        repository,
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
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      onUpdate: vi.fn(),
      repository,
    });
    const controller = new AbortController();
    const tracked = await lifecycle.track(task('task-cancelled-by-caller'), controller.signal);
    const reason = new Error('caller cancelled');

    controller.abort(reason);

    await expect(tracked.settled).rejects.toBe(reason);
    await expect(
      repository.get(taskIdentity(authority, 'task-cancelled-by-caller'))
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
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client,
      limits: DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
      onUpdate: vi.fn(),
      repository,
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
    const authority = await repository.openAuthority(authorityInput);
    const onUpdate = vi.fn();
    const observe = vi.fn();
    const observationPort = new McpTaskObservationPort({ onConsumerError: consumerErrorSink });
    observationPort.subscribe({ fail: vi.fn(), observe });
    const lifecycle = new McpTaskLifecycle({
      authority,
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
      observationPort,
      onUpdate,
      repository,
    });
    const tracked = await lifecycle.track(task('expected-task'));
    const settlement = expect(tracked.settled).rejects.toThrow(/identity mismatch/u);

    await vi.advanceTimersByTimeAsync(100);

    await settlement;
    await expect(repository.get(taskIdentity(authority, 'expected-task'))).resolves.toMatchObject({
      status: 'working',
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expectNoLifecycleLeaks(lifecycle);
  });

  it('settles and publishes bounded transport exhaustion after three lifecycle polls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const failure = new Error('transport lost');
    const publishFailure = vi.fn();
    const observationPort = new McpTaskObservationPort({ onConsumerError: consumerErrorSink });
    observationPort.subscribe({ fail: publishFailure, observe: vi.fn() });
    const requestExtension = vi.fn(() => Promise.reject(failure));
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      limits: {
        ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
        initialPollMs: 10,
        maxBackoffMs: 40,
        minimumPollMs: 10,
      },
      observationPort,
      onUpdate: vi.fn(),
      repository,
    });
    const tracked = await lifecycle.track(task('task-exhausted', { pollIntervalMs: 10 }));
    const settlement = expect(tracked.settled).rejects.toBeInstanceOf(McpTaskObservationError);

    await vi.advanceTimersByTimeAsync(70);

    await settlement;
    expect(requestExtension).toHaveBeenCalledTimes(3);
    expect(publishFailure).toHaveBeenCalledOnce();
    expect(publishFailure).toHaveBeenCalledWith(
      'task-exhausted',
      expect.objectContaining({ cause: failure })
    );
    expectNoLifecycleLeaks(lifecycle);
  });

  it('uses maxTransportFailures as the sole bounded observation-attempt budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const transportFailure = new Error('transport unavailable');
    const requestExtension = vi.fn(() => Promise.reject(transportFailure));
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      limits: {
        ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
        initialPollMs: 10,
        maxBackoffMs: 40,
        maxTransportFailures: 1,
        minimumPollMs: 10,
      },
      onUpdate: vi.fn(),
      repository,
    });
    const tracked = await lifecycle.track(task('task-single-attempt', { pollIntervalMs: 10 }));
    const observeFailure = vi.fn();
    void tracked.settled.catch(observeFailure);

    await vi.advanceTimersByTimeAsync(10);

    try {
      expect(observeFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          cause: transportFailure,
          failures: 1,
          taskId: 'task-single-attempt',
        })
      );
      expect(requestExtension).toHaveBeenCalledOnce();
    } finally {
      await lifecycle.stop('closed');
      expectNoLifecycleLeaks(lifecycle);
    }
  });

  it('exposes bounded transport exhaustion as the terminal observation failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const transportFailure = new Error('transport unavailable');
    const requestExtension = vi.fn(() => Promise.reject(transportFailure));
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const onUpdate = vi.fn();
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      limits: {
        ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
        initialPollMs: 25,
        maxBackoffMs: 100,
        minimumPollMs: 10,
      },
      onUpdate,
      repository,
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
    await expect(repository.get(taskIdentity(authority, 'task-exhausted'))).resolves.toMatchObject({
      status: 'working',
    });
    expectNoLifecycleLeaks(lifecycle);
  });

  it('rejects invalid server timing before persistence instead of silently coercing it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      onUpdate: vi.fn(),
      repository,
    });

    await expect(lifecycle.track(task('invalid-timing', { pollIntervalMs: -1 }))).rejects.toThrow(
      /pollIntervalMs/u
    );
    await expect(repository.get(taskIdentity(authority, 'invalid-timing'))).resolves.toBeNull();
    expectNoLifecycleLeaks(lifecycle);
  });

  it('persists a terminal creation seed that omits its detail and fetches the detail at once', async () => {
    // Review of #2915 (codex): CreateTaskResult extends the BASE task schema,
    // so a create response may claim `completed` without `result`. The handle
    // is durable and must not be discarded; it is stored as `working` with a
    // pending-detail marker and the first tasks/get runs immediately.
    vi.useRealTimers();
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const requestExtension = vi.fn(async () => ({
      ...task('seed-terminal'),
      result: { answer: 42 },
      resultType: 'complete',
      status: 'completed',
    }));
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      onUpdate: vi.fn(),
      repository,
    });

    const tracked = await lifecycle.track({ ...task('seed-terminal'), status: 'completed' });
    expect(tracked.record).toMatchObject({
      inputMetadata: expect.objectContaining({ detail: 'pending', remoteStatus: 'completed' }),
      status: 'working',
    });
    await expect(tracked.settled).resolves.toMatchObject({
      resultMetadata: expect.objectContaining({ result: { answer: 42 } }),
      status: 'completed',
    });
    expect(requestExtension).toHaveBeenCalledTimes(1);
    expectNoLifecycleLeaks(lifecycle);
  });

  it('rejects immutable creation-time drift before persistence or publication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const onUpdate = vi.fn();
    const lifecycle = new McpTaskLifecycle({
      authority,
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
      onUpdate,
      repository,
    });
    const tracked = await lifecycle.track(task('task-time-drift'));
    const settlement = tracked.settled.then(
      () => undefined,
      (error: unknown) => error
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(String(await settlement)).toMatch(/createdAt changed/u);
    await expect(repository.get(taskIdentity(authority, 'task-time-drift'))).resolves.toMatchObject(
      {
        status: 'working',
      }
    );
    expect(onUpdate).not.toHaveBeenCalled();
    expectNoLifecycleLeaks(lifecycle);
  });

  it('clears transient input and status metadata when the task becomes terminal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    let polls = 0;
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
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
      onUpdate: vi.fn(),
      repository,
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

  it('persists a bounded digest and truthful blocked terminal record for oversized remote state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const rawSentinel = `oversized-secret-${'x'.repeat(70_000)}`;
    const onUpdate = vi.fn();
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: vi.fn(
          async (): Promise<GetTaskResult> => ({
            createdAt: CREATED_AT,
            lastUpdatedAt: '2026-09-01T05:00:00.100Z',
            result: { payload: rawSentinel },
            resultType: 'complete',
            status: 'completed',
            taskId: 'task-oversized-result',
            ttlMs: 10_000,
          })
        ),
      },
      onUpdate,
      repository,
    });
    const tracked = await lifecycle.track(task('task-oversized-result'));

    await vi.advanceTimersByTimeAsync(100);

    const settled = await tracked.settled;
    expect(settled).toMatchObject({
      blockedDiagnostic: {
        actualBytes: expect.any(Number),
        code: 'mcp_task_state_too_large',
        field: 'resultMetadata',
        maxBytes: 65_536,
        remoteStatus: 'completed',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      status: 'completed',
      statusMessage: 'MCP task state exceeded the durable metadata limit.',
      terminalAt: expect.any(Date),
    });
    expect(JSON.stringify(settled)).not.toContain(rawSentinel);
    await expect(repository.get(taskIdentity(authority, 'task-oversized-result'))).resolves.toEqual(
      settled
    );
    expect(onUpdate).toHaveBeenCalledWith(settled);
    expectNoLifecycleLeaks(lifecycle);
  });

  it('hydrates a blocked diagnostic written under an older metadata budget', async () => {
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const identity = taskIdentity(authority, 'task-legacy-budget');
    const blockedDiagnostic = {
      actualBytes: 2048,
      code: 'mcp_task_state_too_large',
      field: 'resultMetadata',
      maxBytes: 1024,
      remoteStatus: 'completed',
      sha256: 'a'.repeat(64),
    } as const;
    const created = await repository.create(
      {
        ...identity,
        blockedDiagnostic,
        createdAt: new Date(CREATED_AT),
        inputMetadata: null,
        resultMetadata: { omittedState: blockedDiagnostic },
        status: 'completed',
        statusMessage: 'MCP task state exceeded the durable metadata limit.',
      },
      authority
    );
    expect(created.blockedDiagnostic).toEqual(blockedDiagnostic);
    await expect(repository.get(identity)).resolves.toEqual(created);
    await expect(
      repository.create(
        {
          ...identity,
          blockedDiagnostic: { ...blockedDiagnostic, actualBytes: 1024 },
          createdAt: new Date(CREATED_AT),
          inputMetadata: null,
          resultMetadata: { omittedState: blockedDiagnostic },
          status: 'completed',
          statusMessage: null,
          taskId: 'task-not-over-budget',
        },
        authority
      )
    ).rejects.toThrow(/blockedDiagnostic values are invalid/u);
  });

  it('does not publish oversized input state or send tasks/update after blocking it durably', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const rawSentinel = `oversized-input-${'x'.repeat(7000)}`;
    const observationPort = new McpTaskObservationPort({ onConsumerError: consumerErrorSink });
    const elicitation = vi.fn(async () => ({ action: 'decline' as const }));
    const updateTask = vi.fn(async () => ({ resultType: 'complete' as const }));
    const neverCloses = Promise.withResolvers<void>();
    const interaction = new McpTaskInteraction({
      client: {
        listenTasks: vi.fn(async () => ({
          close: vi.fn(async () => undefined),
          closed: neverCloses.promise,
          honoredTaskIds: [],
        })),
        requestExtension: updateTask,
      },
      elicitation: { form: true, handle: elicitation, url: false },
      observationPort,
      scope: {
        authorityEpoch: authority.authorityEpoch,
        principalId: authority.principalId,
        resource: authority.resource,
        serverId: authority.serverId,
      },
    });
    const onUpdate = vi.fn();
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: vi.fn(
          async (): Promise<GetTaskResult> => ({
            createdAt: CREATED_AT,
            inputRequests: {
              ...Object.fromEntries(
                Array.from({ length: 10 }, (_, index) => `approval-${index}`).map((inputKey) => [
                  inputKey,
                  {
                    method: 'elicitation/create' as const,
                    params: {
                      message: `${inputKey}:${rawSentinel}`,
                      mode: 'form' as const,
                      requestedSchema: {
                        properties: { approved: { type: 'boolean' as const } },
                        required: ['approved'],
                        type: 'object' as const,
                      },
                    },
                  },
                ])
              ),
            },
            lastUpdatedAt: '2026-09-01T05:00:00.100Z',
            resultType: 'task',
            status: 'input_required',
            taskId: 'task-oversized-input',
            ttlMs: 10_000,
          })
        ),
      },
      observationPort,
      onUpdate,
      repository,
    });
    await interaction.start(['task-oversized-input']);
    const tracked = await lifecycle.track(task('task-oversized-input'));

    await vi.advanceTimersByTimeAsync(100);

    const settled = await tracked.settled;
    expect(settled).toMatchObject({
      blockedDiagnostic: {
        code: 'mcp_task_state_too_large',
        field: 'inputMetadata',
        remoteStatus: 'input_required',
      },
      status: 'input_required',
    });
    expect(JSON.stringify(settled)).not.toContain(rawSentinel);
    expect(onUpdate).toHaveBeenCalledWith(settled);
    try {
      expect(elicitation.mock.calls.length).toBe(0);
      expect(updateTask.mock.calls.length).toBe(0);
    } finally {
      await interaction.close();
      expectNoLifecycleLeaks(lifecycle);
    }
  });

  it('waits for an in-flight create before reset clears the real database', async () => {
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
    const authority = await repository.openAuthority(authorityInput);
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      onUpdate: vi.fn(),
      repository,
    });

    const tracking = lifecycle.track(task('task-reset-race'));
    await insertStarted.promise;
    const stopping = lifecycle.stop('reset');
    let stopSettled = false;
    void stopping.then(() => {
      stopSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopSettled).toBe(false);
    expect(lifecycle.snapshot().pendingCreates).toBe(1);
    releaseInsert.resolve(undefined);

    await expect(tracking).rejects.toMatchObject({ reason: 'reset' });
    await stopping;
    await db.exec(`
      BEGIN;
      DELETE FROM brainstrike_mcp_tasks;
      DELETE FROM brainstrike_mcp_task_authorities;
      COMMIT;
    `);
    const remaining = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM brainstrike_mcp_tasks'
    );
    expect(remaining.rows).toEqual([{ count: 0 }]);
    expectNoLifecycleLeaks(lifecycle);
  });

  it('validates every durable recovery row before starting any poller', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    await repository.create(
      {
        ...taskIdentity(authority, 'a-valid'),
        inputMetadata: {
          lifecycle: {
            createdAt: CREATED_AT,
            lastUpdatedAt: CREATED_AT,
            pollIntervalMs: 100,
            ttlMs: 10_000,
          },
        },
        status: 'working',
      },
      authority
    );
    await repository.create(
      {
        ...taskIdentity(authority, 'b-corrupt'),
        status: 'working',
      },
      authority
    );
    const lifecycle = new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      onUpdate: vi.fn(),
      repository,
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
    const authority = await repository.openAuthority(authorityInput);
    const firstLifecycle = new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: vi.fn(() => Promise.reject(new Error('poll must not start'))),
      },
      limits: { ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS, maxLifetimeMs: 250 },
      onUpdate: vi.fn(),
      repository,
    });
    const original = await firstLifecycle.track(task('task-null-ttl', { ttlMs: null }));
    await firstLifecycle.stop('restart');
    await expect(original.settled).rejects.toMatchObject({ reason: 'restart' });
    await vi.advanceTimersByTimeAsync(200);

    const requestExtension = vi.fn(() => Promise.reject(new Error('poll must not start')));
    const recoveredLifecycle = new McpTaskLifecycle({
      authority,
      client: { requestExtension },
      limits: { ...DEFAULT_MCP_TASK_LIFECYCLE_LIMITS, maxLifetimeMs: 250 },
      onUpdate: vi.fn(),
      repository,
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
