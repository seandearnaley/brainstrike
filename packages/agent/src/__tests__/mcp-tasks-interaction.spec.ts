import {
  type ElicitRequest,
  type ElicitResult,
  type JSONObject,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpClientExtensionRequestContract } from '../mcp/client-extension-registry.js';
import {
  MCP_TASKS_UPDATE_REQUEST_CONTRACT,
  type McpTasksNotificationHandler,
  type McpTasksNotificationLease,
} from '../mcp/tasks-extension.js';
import {
  McpTaskCancellationOutcomeError,
  McpTaskInteraction,
  type McpTaskInteractionClient,
  type McpTaskInteractionElicitationContext,
} from '../mcp/tasks-interaction.js';
import { McpTaskObservationError, McpTaskObservationPort } from '../mcp/tasks-observation.js';

const consumerErrorSink = (taskId: string, error: unknown): void => {
  throw new Error(`unexpected consumer error for ${taskId}: ${String(error)}`);
};

const CREATED_AT = '2026-09-01T09:00:00.000Z';
const scope = {
  generation: 13,
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  serverId: 'linear',
} as const;

function deferred<Value>() {
  return Promise.withResolvers<Value>();
}

function taskStatus(taskId: string, status: 'cancelled' | 'completed' | 'failed' | 'working') {
  const common = {
    createdAt: CREATED_AT,
    lastUpdatedAt: CREATED_AT,
    status,
    taskId,
    ttlMs: 10_000,
  };
  if (status === 'completed') {
    return { ...common, result: { content: [] } } as const;
  }
  if (status === 'failed') {
    return { ...common, error: { code: -32_603, message: 'remote failure' } } as const;
  }
  return common;
}

function inputRequiredTask(taskId: string) {
  return {
    ...taskStatus(taskId, 'working'),
    inputRequests: {
      approval: {
        method: 'elicitation/create' as const,
        params: {
          message: 'Approve the task result?',
          mode: 'form' as const,
          requestedSchema: {
            properties: { approved: { type: 'boolean' as const } },
            required: ['approved'],
            type: 'object' as const,
          },
        },
      },
    },
    status: 'input_required' as const,
  };
}

interface FakeClient {
  readonly client: McpTaskInteractionClient;
  readonly endSubscription: () => void;
  readonly failSubscription: (error: unknown) => void;
  readonly handler: () => McpTasksNotificationHandler;
  readonly listenTasks: ReturnType<typeof vi.fn>;
  readonly observationPort: McpTaskObservationPort;
  readonly requestExtension: ReturnType<typeof vi.fn>;
  readonly wake: ReturnType<typeof vi.fn>;
}

function createClient(): FakeClient {
  let handler: McpTasksNotificationHandler | undefined;
  const closed = deferred<unknown>();
  const observationPort = new McpTaskObservationPort({ onConsumerError: consumerErrorSink });
  const wake = vi.fn();
  observationPort.attachAuthority({ wake });
  const release = (): void => {
    if (handler) {
      handler = undefined;
    }
  };
  const close = vi.fn(async () => {
    release();
    closed.resolve(undefined);
  });
  const requestExtension = vi.fn(
    async <Params extends JSONObject, Result>(
      _contract: McpClientExtensionRequestContract<Params, Result>,
      _params: Params
    ): Promise<Result> => ({ resultType: 'complete' }) as Result
  );
  const listenTasks = vi.fn(
    async (
      taskIds: readonly string[],
      next: McpTasksNotificationHandler
    ): Promise<McpTasksNotificationLease> => {
      handler = next;
      return { close, closed: closed.promise, honoredTaskIds: taskIds };
    }
  );
  return {
    client: { listenTasks, requestExtension },
    endSubscription: () => {
      release();
      closed.resolve(undefined);
    },
    failSubscription: (error) => {
      release();
      closed.reject(error);
    },
    handler: () => {
      if (!handler) {
        throw new Error('Task notification handler was not installed.');
      }
      return handler;
    },
    listenTasks,
    observationPort,
    requestExtension,
    wake,
  };
}

function createInteraction(
  fake: FakeClient,
  handle: (
    request: ElicitRequest,
    context: McpTaskInteractionElicitationContext
  ) => Promise<ElicitResult> = async () => ({ action: 'decline' })
): McpTaskInteraction {
  return new McpTaskInteraction({
    client: fake.client,
    elicitation: { form: true, handle, url: false },
    observationPort: fake.observationPort,
    scope,
  });
}

/** An interaction whose consumer failures are recorded, as the host's diagnostic sink does. */
function createRecordedInteraction(
  fake: FakeClient,
  handle: (
    request: ElicitRequest,
    context: McpTaskInteractionElicitationContext
  ) => Promise<ElicitResult>
) {
  const consumerErrors: unknown[] = [];
  const observationPort = new McpTaskObservationPort({
    onConsumerError: (_taskId, error) => consumerErrors.push(error),
  });
  observationPort.attachAuthority({ wake: vi.fn() });
  const interaction = new McpTaskInteraction({
    client: fake.client,
    elicitation: { form: true, handle, url: false },
    observationPort,
    scope,
  });
  return { consumerErrors, interaction, observationPort };
}

const approved: ElicitResult = { action: 'accept', content: { approved: true } };

afterEach(() => vi.useRealTimers());
describe('McpTaskInteraction', () => {
  it('deduplicates task input and preserves exact elicitation and update provenance', async () => {
    const decision = deferred<ElicitResult>();
    const handle = vi.fn(async () => await decision.promise);
    const fake = createClient();
    const interaction = createInteraction(fake, handle);
    await interaction.start(['task-1']);
    const first = fake.observationPort.publish(inputRequiredTask('task-1'));
    const repeated = fake.observationPort.publish(inputRequiredTask('task-1'));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    expect(handle.mock.calls[0]?.[1]).toMatchObject({
      ...scope,
      inputKey: 'approval',
      requestId: 'approval',
      serverName: 'linear',
      taskId: 'task-1',
    });
    decision.resolve({ action: 'accept', content: { approved: true } });
    await Promise.all([first, repeated]);
    expect(fake.requestExtension).toHaveBeenCalledOnce();
    expect(fake.requestExtension).toHaveBeenCalledWith(
      MCP_TASKS_UPDATE_REQUEST_CONTRACT,
      {
        inputResponses: { approval: { action: 'accept', content: { approved: true } } },
        taskId: 'task-1',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    await interaction.close();
  });
  it('dynamically admits tasks and settles cancellation from lifecycle observations after notification loss', async () => {
    const fake = createClient();
    const interaction = createInteraction(fake);
    await interaction.start(['task-1']);
    fake.endSubscription();
    await vi.waitFor(() => expect(interaction.snapshot().subscriptionActive).toBe(false));
    interaction.admit('task-2');
    const cancellation = interaction.cancel('task-2');
    await fake.observationPort.publish(taskStatus('task-2', 'cancelled'));
    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled', taskId: 'task-2' });
    expect(interaction.notificationFailure()).toBeInstanceOf(Error);
    expect(fake.listenTasks).toHaveBeenCalledWith(
      ['task-1'],
      expect.any(Function),
      expect.any(Object)
    );
    expect(fake.requestExtension).toHaveBeenCalledOnce();
    await interaction.close();
  });
  it('publicly records lifecycle observation exhaustion and rejects cancellation', async () => {
    const fake = createClient();
    const interaction = createInteraction(fake);
    await interaction.start(['task-1']);
    const cancellation = interaction.cancel('task-1');
    const failure = new McpTaskObservationError('task-1', 3, new Error('transport lost'));
    fake.observationPort.publishFailure('task-1', failure);
    await expect(cancellation).rejects.toBeInstanceOf(McpTaskObservationError);
    expect(interaction.observationFailure('task-1')).toBe(failure);
    expect(interaction.snapshot().activeCancellations).toBe(0);
    await interaction.close();
  });

  it('uses notifications only to coalesce a lifecycle poll wake', async () => {
    const handle = vi.fn(async (): Promise<ElicitResult> => ({ action: 'decline' }));
    const fake = createClient();
    const interaction = createInteraction(fake, handle);
    await interaction.start(['task-1']);

    await fake.handler()(inputRequiredTask('task-1'));

    expect(fake.wake).toHaveBeenCalledOnce();
    expect(fake.wake).toHaveBeenCalledWith('task-1');
    expect(handle).not.toHaveBeenCalled();
    await fake.observationPort.publish(inputRequiredTask('task-1'));
    expect(handle).toHaveBeenCalledOnce();
    await interaction.close();
  });

  it('records rejected subscription closure without an unhandled rejection', async () => {
    const fake = createClient();
    const interaction = createInteraction(fake);
    await interaction.start(['task-1']);
    const failure = new Error('subscription transport failed');

    fake.failSubscription(failure);
    await vi.waitFor(() => expect(interaction.snapshot().subscriptionActive).toBe(false));

    expect(interaction.notificationFailure()).toBe(failure);
    await interaction.close();
  });

  it('withdraws unanswered input without cancelling the task and presents a re-request afresh', async () => {
    const presented: AbortSignal[] = [];
    const fake = createClient();
    // The user never answers; only a withdrawal or close ends the input.
    const interaction = createInteraction(fake, (_request, context) => {
      presented.push(context.signal);
      return new Promise<ElicitResult>(() => undefined);
    });
    await interaction.start(['task-1']);
    const parked = fake.observationPort.publish(inputRequiredTask('task-1'));
    await vi.waitFor(() => expect(presented).toHaveLength(1));

    interaction.withdraw('task-1');

    expect(presented[0]?.aborted).toBe(true);
    await expect(parked).resolves.toBeUndefined();
    // Neither tasks/update nor tasks/cancel: the task itself is left to the server.
    expect(fake.requestExtension).not.toHaveBeenCalled();
    expect(interaction.snapshot()).toMatchObject({ activeCancellations: 0, activeInputs: 0 });
    // A later observation of the same key (a recovered poller) asks again.
    const recovered = fake.observationPort.publish(inputRequiredTask('task-1'));
    await vi.waitFor(() => expect(presented).toHaveLength(2));
    expect(presented[1]?.aborted).toBe(false);
    await interaction.close();
    await expect(recovered).rejects.toThrow(/unexpected consumer error for task-1/u);
  });

  it('retires superseded input before a stale user response can be delivered', async () => {
    const decision = deferred<ElicitResult>();
    const fake = createClient();
    const interaction = createInteraction(fake, async () => await decision.promise);
    await interaction.start(['task-1']);
    const input = fake.observationPort.publish(inputRequiredTask('task-1'));
    await fake.observationPort.publish(taskStatus('task-1', 'working'));
    decision.resolve({ action: 'accept', content: { approved: true } });
    await expect(input).rejects.toThrow(/superseded/u);
    expect(fake.requestExtension).not.toHaveBeenCalledWith(
      MCP_TASKS_UPDATE_REQUEST_CONTRACT,
      expect.anything(),
      expect.anything()
    );
    // A server that legitimately re-requests the withdrawn key restarts the
    // exactly-once cycle instead of poisoning the key for the task's life.
    await fake.observationPort.publish(inputRequiredTask('task-1'));
    await vi.waitFor(() =>
      expect(fake.requestExtension).toHaveBeenCalledWith(
        MCP_TASKS_UPDATE_REQUEST_CONTRACT,
        expect.anything(),
        expect.anything()
      )
    );
    await interaction.close();
  });

  // The server below applies every `inputResponses` it receives, which the pinned
  // ext-tasks 2026-07-28 spec permits (tasks.md L379: ignoring an answered key is
  // only a SHOULD), and its ack is eventually consistent (L377), so its next poll
  // still lists the answered key.
  it('fences an applied tasks/update whose acknowledgement was lost instead of resending it', async () => {
    const fake = createClient();
    const applied: unknown[] = [];
    fake.requestExtension.mockImplementation(async (_contract: unknown, params: unknown) => {
      applied.push(params);
      if (applied.length === 1) {
        // Applied, then the connection closed before the empty-result ack arrived.
        throw new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed');
      }
      return { resultType: 'complete' };
    });
    const handle = vi.fn(async (): Promise<ElicitResult> => approved);
    const { consumerErrors, interaction, observationPort } = createRecordedInteraction(
      fake,
      handle
    );
    await interaction.start(['task-1']);
    await observationPort.publish(inputRequiredTask('task-1'));
    await observationPort.publish(inputRequiredTask('task-1'));
    expect(applied).toHaveLength(1);
    expect(handle).toHaveBeenCalledOnce();
    expect(consumerErrors).toEqual([
      expect.objectContaining({ code: SdkErrorCode.ConnectionClosed }),
      expect.objectContaining({ name: 'McpTaskInputDeliveryUnknownError' }),
    ]);
    await interaction.close();
  });

  it('fences an answer whose in-flight tasks/update was withdrawn instead of presenting it again', async () => {
    const fake = createClient();
    const applied: unknown[] = [];
    const dispatched = deferred<void>();
    fake.requestExtension.mockImplementation(
      (_contract: unknown, params: unknown, options?: { readonly signal?: AbortSignal }) => {
        applied.push(params);
        if (applied.length > 1) {
          return Promise.resolve({ resultType: 'complete' });
        }
        dispatched.resolve();
        // Applied by the server; its ack has not arrived when the input is withdrawn.
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new SdkError(SdkErrorCode.RequestTimeout, 'Request aborted')),
            { once: true }
          );
        });
      }
    );
    const handle = vi.fn(async (): Promise<ElicitResult> => approved);
    const { consumerErrors, interaction, observationPort } = createRecordedInteraction(
      fake,
      handle
    );
    await interaction.start(['task-1']);
    const first = observationPort.publish(inputRequiredTask('task-1'));
    await dispatched.promise;
    interaction.withdraw('task-1');
    await first;
    // A recovered poller observes the same key; the server may already have applied it.
    await observationPort.publish(inputRequiredTask('task-1'));
    expect(applied).toHaveLength(1);
    expect(handle).toHaveBeenCalledOnce();
    expect(consumerErrors).toEqual([
      expect.objectContaining({ name: 'McpTaskInputDeliveryUnknownError' }),
    ]);
    await interaction.close();
  });

  it('resends the same answer after a definite server rejection without asking again', async () => {
    const fake = createClient();
    const received: unknown[] = [];
    fake.requestExtension.mockImplementation(async (_contract: unknown, params: unknown) => {
      received.push(params);
      if (received.length === 1) {
        // A JSON-RPC error response: the server answered, and not with the ack (L377).
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'Unexpected input response');
      }
      return { resultType: 'complete' };
    });
    const handle = vi.fn(async (): Promise<ElicitResult> => approved);
    const { consumerErrors, interaction, observationPort } = createRecordedInteraction(
      fake,
      handle
    );
    await interaction.start(['task-1']);
    await observationPort.publish(inputRequiredTask('task-1'));
    await observationPort.publish(inputRequiredTask('task-1'));
    // The ack is positive; a poll that still lists the key (L377) sends nothing more.
    await observationPort.publish(inputRequiredTask('task-1'));
    const update = { inputResponses: { approval: approved }, taskId: 'task-1' };
    expect(received).toEqual([update, update]);
    expect(handle).toHaveBeenCalledOnce();
    expect(consumerErrors).toEqual([expect.objectContaining({ name: 'ProtocolError' })]);
    await interaction.close();
  });

  it('rejects changed lifetime-key reuse without presenting the request again', async () => {
    const decision = deferred<ElicitResult>();
    const handle = vi.fn(async () => await decision.promise);
    const fake = createClient();
    const interaction = createInteraction(fake, handle);
    await interaction.start(['task-1']);
    const first = fake.observationPort.publish(inputRequiredTask('task-1'));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    const changed = inputRequiredTask('task-1');
    await expect(
      fake.observationPort.publish({
        ...changed,
        inputRequests: {
          approval: {
            ...changed.inputRequests.approval,
            params: { ...changed.inputRequests.approval.params, message: 'Changed request' },
          },
        },
      })
    ).rejects.toThrow(/reused input key/u);
    decision.resolve({ action: 'decline' });
    await first;
    expect(handle).toHaveBeenCalledOnce();
    await interaction.close();
  });

  it.each(['completed', 'failed'] as const)(
    'reports %s as a non-cancellation terminal outcome',
    async (status) => {
      const fake = createClient();
      const interaction = createInteraction(fake);
      await interaction.start(['task-1']);
      const cancellation = interaction.cancel('task-1');
      await fake.observationPort.publish(taskStatus('task-1', status));
      await expect(cancellation).rejects.toEqual(
        new McpTaskCancellationOutcomeError('task-1', status)
      );
      await interaction.close();
    }
  );

  it('records a visible notification failure when the server honors no task ids', async () => {
    const fake = createClient();
    fake.client.listenTasks.mockImplementationOnce(async () => ({
      close: vi.fn(async () => undefined),
      closed: new Promise<undefined>(() => undefined),
      honoredTaskIds: [],
    }));
    const interaction = createInteraction(fake);
    await interaction.start(['task-1']);
    expect(interaction.snapshot().subscriptionActive).toBe(false);
    expect(interaction.notificationFailure()).toBeInstanceOf(Error);
    expect(String(interaction.notificationFailure())).toMatch(/honored no requested task ids/u);
    await interaction.close();
  });

  it('fences an abort-ignorant input callback when the coordinator closes', async () => {
    const decision = deferred<ElicitResult>();
    const fake = createClient();
    const interaction = createInteraction(fake, async () => await decision.promise);
    await interaction.start(['task-1']);
    const input = fake.observationPort.publish(inputRequiredTask('task-1'));
    await interaction.close();
    await expect(input).rejects.toThrow(/closed/u);
    decision.resolve({ action: 'accept', content: { approved: true } });
    expect(fake.requestExtension).not.toHaveBeenCalled();
  });

  it('closes while an abort-ignorant cancellation acknowledgement remains unresolved', async () => {
    const acknowledgement = deferred<unknown>();
    const fake = createClient();
    fake.requestExtension.mockImplementationOnce(async () => await acknowledgement.promise);
    const interaction = createInteraction(fake);
    await interaction.start(['task-1']);
    const cancellation = interaction.cancel('task-1');
    await vi.waitFor(() => expect(fake.requestExtension).toHaveBeenCalledOnce());
    await interaction.close();
    await expect(cancellation).rejects.toThrow(/closed/u);
    expect(interaction.snapshot()).toEqual({
      activeCancellations: 0,
      activeInputs: 0,
      inputKeys: 0,
      subscriptionActive: false,
    });
    acknowledgement.resolve({ resultType: 'complete' });
  });
});
