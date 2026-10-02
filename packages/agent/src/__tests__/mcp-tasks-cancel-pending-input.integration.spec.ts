import { McpTaskRepository, MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';
import type { PGlite } from '@electric-sql/pglite';
import type { ElicitResult, JSONObject } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpClientExtensionRequestContract } from '../mcp/client-extension-registry.js';
import {
  McpTaskInteraction,
  type McpTaskInteractionClient,
  type McpTaskInteractionElicitationContext,
} from '../mcp/tasks-interaction.js';
import {
  DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
  McpTaskLifecycle,
  type McpTaskPollingClient,
} from '../mcp/tasks-lifecycle.js';
import { McpTaskObservationPort } from '../mcp/tasks-observation.js';

const CREATED_AT = '2026-09-01T06:00:00.000Z';
const POLL_MS = 100;
const TASK_ID = 'task-approval';
const authorityInput = {
  connectionGeneration: 11,
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  runtimeId: 'desktop-runtime-a',
  serverId: 'linear',
} as const;

// The Tasks reference server's input request (`TASKS_PROFILE.input` in
// packages/mcp-test-lab/src/tasks-profile.ts).
const approvalRequest = {
  method: 'elicitation/create' as const,
  params: {
    message: 'Approve the reference task?',
    mode: 'form' as const,
    requestedSchema: {
      properties: { approved: { type: 'boolean' as const } },
      required: ['approved'],
      type: 'object' as const,
    },
  },
};

function updatedAt(offsetMs: number): string {
  return new Date(Date.parse(CREATED_AT) + offsetMs).toISOString();
}

function observation(
  status: 'cancelled' | 'completed' | 'input_required',
  offsetMs: number
): GetTaskResult {
  const common = {
    createdAt: CREATED_AT,
    lastUpdatedAt: updatedAt(offsetMs),
    pollIntervalMs: POLL_MS,
    resultType: 'complete' as const,
    taskId: TASK_ID,
    ttlMs: 60_000,
  };
  if (status === 'input_required') {
    return { ...common, inputRequests: { approval: approvalRequest }, status };
  }
  if (status === 'completed') {
    return { ...common, result: { content: [{ text: 'done', type: 'text' }] }, status };
  }
  return { ...common, status };
}

interface FakeTaskServer {
  readonly cancelReceived: Promise<void>;
  /** The interaction's client: it may only write, never poll. */
  readonly interactionClient: McpTaskInteractionClient;
  /** Every request the server received, in arrival order. */
  readonly log: string[];
  /** The lifecycle's client: it may only poll. */
  readonly pollingClient: McpTaskPollingClient;
  readonly updateReceived: Promise<void>;
}

function createTaskServer(onGet: (server: FakeTaskServer) => GetTaskResult): FakeTaskServer {
  const log: string[] = [];
  const cancelReceived = Promise.withResolvers<void>();
  const updateReceived = Promise.withResolvers<void>();
  const neverCloses = new Promise<never>(() => undefined);
  const receive = (method: string, allowed: readonly string[]): void => {
    if (!allowed.includes(method)) {
      throw new Error(`Unexpected ${method} on a client that only sends ${allowed.join(', ')}.`);
    }
    log.push(method);
  };
  const server: FakeTaskServer = {
    cancelReceived: cancelReceived.promise,
    interactionClient: {
      listenTasks: async (taskIds) => ({
        close: async () => undefined,
        closed: neverCloses,
        honoredTaskIds: taskIds,
      }),
      requestExtension: async <Params extends JSONObject, Result>(
        contract: McpClientExtensionRequestContract<Params, Result>
      ): Promise<Result> => {
        receive(contract.method, ['tasks/cancel', 'tasks/update']);
        (contract.method === 'tasks/cancel' ? cancelReceived : updateReceived).resolve();
        return { resultType: 'complete' } as Result;
      },
    },
    log,
    pollingClient: {
      requestExtension: async <Params extends JSONObject, Result>(
        contract: McpClientExtensionRequestContract<Params, Result>
      ): Promise<Result> => {
        receive(contract.method, ['tasks/get']);
        return onGet(server) as Result;
      },
    },
    updateReceived: updateReceived.promise,
  };
  return server;
}

async function openDatabase(): Promise<PGlite> {
  const db = await wasmLoader.createPGlite('memory://');
  const runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations);
  return db;
}

async function startTaskSession(db: PGlite, server: FakeTaskServer) {
  const repository = new McpTaskRepository(db);
  const authority = await repository.openAuthority(authorityInput);
  const consumerErrors: unknown[] = [];
  const observationPort = new McpTaskObservationPort({
    onConsumerError: (_taskId, error) => {
      consumerErrors.push(error);
    },
  });
  const decision = Promise.withResolvers<ElicitResult>();
  const presented = Promise.withResolvers<McpTaskInteractionElicitationContext>();
  const handle = vi.fn(async (_request: unknown, context: McpTaskInteractionElicitationContext) => {
    presented.resolve(context);
    return await decision.promise;
  });
  const interaction = new McpTaskInteraction({
    client: server.interactionClient,
    elicitation: { form: true, handle, url: false },
    observationPort,
    scope: {
      authorityEpoch: authority.authorityEpoch,
      principalId: authority.principalId,
      resource: authority.resource,
      serverId: authority.serverId,
    },
  });
  const lifecycle = new McpTaskLifecycle({
    authority,
    client: server.pollingClient,
    limits: DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
    observationPort,
    onUpdate: vi.fn(),
    repository,
  });
  await interaction.start([TASK_ID]);
  const tracked = await lifecycle.track({
    createdAt: CREATED_AT,
    lastUpdatedAt: CREATED_AT,
    pollIntervalMs: POLL_MS,
    resultType: 'task',
    status: 'working',
    taskId: TASK_ID,
    ttlMs: 60_000,
  });
  return { consumerErrors, decision, handle, interaction, lifecycle, presented, tracked };
}

describe('McpTaskInteraction cancellation of a task waiting on input (BST-1948)', () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await db?.close();
    db = undefined;
  });

  it('sends tasks/cancel at once, withdraws the pending input, and refuses its late answer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    // Cancellation is eventually consistent (Tasks 2026-07-28, "Task
    // Cancellation"): the first poll after the ack may still report the same
    // outstanding input; the next one reports `cancelled`.
    const server = createTaskServer(({ log }) => {
      if (!log.includes('tasks/cancel')) {
        return observation('input_required', 100);
      }
      return log.filter((method) => method === 'tasks/get').length === 2
        ? observation('input_required', 200)
        : observation('cancelled', 300);
    });
    const session = await startTaskSession(db, server);
    try {
      // 1. The task moves to input_required and raises its input request.
      await vi.advanceTimersByTimeAsync(POLL_MS);
      const presented = await session.presented.promise;
      expect(presented.signal.aborted).toBe(false);

      // 2-3. Cancelling while that request is unanswered sends tasks/cancel
      // without waiting for an answer.
      const cancellation = session.interaction.cancel(TASK_ID);
      await server.cancelReceived;
      expect(server.log).toEqual(['tasks/get', 'tasks/cancel']);

      // 4. The pending request is withdrawn: the presenter's signal aborts
      // and no input is pending any more.
      expect(presented.signal.aborted).toBe(true);
      expect(presented.signal.reason).toMatchObject({ name: 'McpTaskInputWithdrawnError' });
      expect(session.interaction.snapshot().activeInputs).toBe(0);

      // 5. A late answer is refused: it never reaches the server, the
      // request is never presented again, and the sole poller observes the
      // terminal state.
      session.decision.resolve({ action: 'accept', content: { approved: true } });
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(session.handle).toHaveBeenCalledOnce();
      await expect(cancellation).resolves.toMatchObject({ status: 'cancelled', taskId: TASK_ID });
      await expect(session.tracked.settled).resolves.toMatchObject({ status: 'cancelled' });
      expect(server.log).toEqual(['tasks/get', 'tasks/cancel', 'tasks/get', 'tasks/get']);
      expect(session.consumerErrors).toEqual([]);
    } finally {
      await session.interaction.close();
      await session.lifecycle.stop('closed');
    }
    expect(session.interaction.snapshot()).toEqual({
      activeCancellations: 0,
      activeInputs: 0,
      inputKeys: 0,
      subscriptionActive: false,
    });
  });

  it('keeps the sole poller ordered behind an unanswered input that is not cancelled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    db = await openDatabase();
    const server = createTaskServer(({ log }) =>
      log.includes('tasks/update')
        ? observation('completed', 200)
        : observation('input_required', 100)
    );
    const session = await startTaskSession(db, server);
    try {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await session.presented.promise;

      // Ten poll intervals pass while the input is unanswered: the poller
      // holds no poll in flight and none scheduled.
      await vi.advanceTimersByTimeAsync(POLL_MS * 10);
      expect(server.log).toEqual(['tasks/get']);
      expect(session.lifecycle.snapshot()).toMatchObject({
        activePolls: 0,
        activeTasks: 1,
        queuedPolls: 0,
        timers: 0,
      });

      // The answer reaches the server before the next ordered poll.
      session.decision.resolve({ action: 'accept', content: { approved: true } });
      await server.updateReceived;
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await expect(session.tracked.settled).resolves.toMatchObject({ status: 'completed' });
      expect(server.log).toEqual(['tasks/get', 'tasks/update', 'tasks/get']);
      expect(session.consumerErrors).toEqual([]);
    } finally {
      await session.interaction.close();
      await session.lifecycle.stop('closed');
    }
  });
});
