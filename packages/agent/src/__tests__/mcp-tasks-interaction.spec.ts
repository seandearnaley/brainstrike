import type { ElicitRequest, ElicitResult, JSONObject } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { McpClientExtensionRequestContract } from '../mcp/client-extension-registry.js';
import {
  MCP_TASKS_CANCEL_REQUEST_CONTRACT,
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

const CREATED_AT = '2026-09-01T09:00:00.000Z';
const scope = {
  generation: 13,
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  serverId: 'linear',
} as const;

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  const state = Promise.withResolvers<Value>();
  return { promise: state.promise, resolve: state.resolve };
}

function inputRequiredTask(taskId: string) {
  return {
    createdAt: CREATED_AT,
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
    lastUpdatedAt: CREATED_AT,
    status: 'input_required' as const,
    taskId,
    ttlMs: 10_000,
  };
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

function createClient(): {
  readonly activeListeners: () => number;
  readonly client: McpTaskInteractionClient;
  readonly close: ReturnType<typeof vi.fn>;
  readonly endSubscription: () => void;
  readonly handler: () => McpTasksNotificationHandler;
  readonly requestExtension: ReturnType<typeof vi.fn>;
} {
  let taskHandler: McpTasksNotificationHandler | undefined;
  let listeners = 0;
  const closed = Promise.withResolvers<unknown>();
  const releaseListener = (): void => {
    if (taskHandler) {
      taskHandler = undefined;
      listeners -= 1;
    }
  };
  const close = vi.fn(async () => {
    releaseListener();
    closed.resolve(undefined);
  });
  const requestExtension = vi.fn(
    async <Params extends JSONObject, Result>(
      _contract: McpClientExtensionRequestContract<Params, Result>,
      _params: Params
    ): Promise<Result> => ({ resultType: 'complete' }) as Result
  );
  const client: McpTaskInteractionClient = {
    listenTasks: vi.fn(
      async (
        _taskIds: readonly string[],
        handler: McpTasksNotificationHandler
      ): Promise<McpTasksNotificationLease> => {
        if (taskHandler) {
          throw new Error('Test client already has a task listener.');
        }
        taskHandler = handler;
        listeners += 1;
        return { close, closed: closed.promise };
      }
    ),
    requestExtension,
  };
  return {
    activeListeners: () => listeners,
    client,
    close,
    endSubscription: () => {
      releaseListener();
      closed.resolve(undefined);
    },
    handler: () => {
      if (!taskHandler) {
        throw new Error('Task notification handler was not installed.');
      }
      return taskHandler;
    },
    requestExtension,
  };
}

describe('McpTaskInteraction', () => {
  it('deduplicates a mid-flight input key and preserves scoped elicitation provenance', async () => {
    const decision = deferred<ElicitResult>();
    const handle = vi.fn(
      async (
        _request: ElicitRequest,
        _context: McpTaskInteractionElicitationContext
      ): Promise<ElicitResult> => await decision.promise
    );
    const fake = createClient();
    const interaction = new McpTaskInteraction({
      client: fake.client,
      elicitation: { form: true, handle, url: false },
      scope,
    });
    await interaction.start(['task-1']);

    const first = fake.handler()(inputRequiredTask('task-1'));
    const repeated = fake.handler()(inputRequiredTask('task-1'));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    expect(handle.mock.calls[0]?.[1]).toMatchObject({
      ...scope,
      inputKey: 'approval',
      requestId: 'approval',
      serverName: 'linear',
      taskId: 'task-1',
    });

    decision.resolve({ action: 'accept', content: { approved: true } });
    await Promise.all([first, repeated]);

    expect(fake.requestExtension).toHaveBeenCalledTimes(1);
    expect(fake.requestExtension).toHaveBeenCalledWith(
      MCP_TASKS_UPDATE_REQUEST_CONTRACT,
      {
        inputResponses: {
          approval: { action: 'accept', content: { approved: true } },
        },
        taskId: 'task-1',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    await interaction.close();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.activeListeners()).toBe(0);
    expect(interaction.snapshot()).toEqual({
      activeCancellations: 0,
      activeInputs: 0,
      inputKeys: 0,
      subscriptionActive: false,
    });
  });

  it('reports cooperative cancellation only after the remote task is cancelled', async () => {
    const fake = createClient();
    const interaction = new McpTaskInteraction({
      client: fake.client,
      elicitation: {
        form: true,
        handle: vi.fn(async () => ({ action: 'decline' })),
        url: false,
      },
      scope,
    });
    await interaction.start(['task-1']);

    const first = interaction.cancel('task-1');
    const repeated = interaction.cancel('task-1');
    let settled = false;
    void first.finally(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(fake.requestExtension).toHaveBeenCalledWith(
        MCP_TASKS_CANCEL_REQUEST_CONTRACT,
        { taskId: 'task-1' },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    await fake.handler()(taskStatus('task-1', 'working'));
    await Promise.resolve();
    expect(settled).toBe(false);

    await fake.handler()(taskStatus('task-1', 'cancelled'));
    await expect(first).resolves.toEqual({ ...scope, status: 'cancelled', taskId: 'task-1' });
    await expect(repeated).resolves.toEqual({ ...scope, status: 'cancelled', taskId: 'task-1' });
    expect(fake.requestExtension).toHaveBeenCalledTimes(1);

    await interaction.close();
  });

  it.each(['decline', 'cancel'] as const)(
    'delivers an elicitation %s decision exactly once',
    async (action) => {
      const fake = createClient();
      const handle = vi.fn(async (): Promise<ElicitResult> => ({ action }));
      const interaction = new McpTaskInteraction({
        client: fake.client,
        elicitation: { form: true, handle, url: false },
        scope,
      });
      await interaction.start(['task-1']);

      await fake.handler()(inputRequiredTask('task-1'));
      await fake.handler()(inputRequiredTask('task-1'));

      expect(handle).toHaveBeenCalledTimes(1);
      expect(fake.requestExtension).toHaveBeenCalledTimes(1);
      expect(fake.requestExtension.mock.calls[0]?.[1]).toEqual({
        inputResponses: { approval: { action } },
        taskId: 'task-1',
      });
      await interaction.close();
    }
  );

  it('rejects lifetime key reuse with a changed request without presenting it again', async () => {
    const decision = deferred<ElicitResult>();
    const handle = vi.fn(async (): Promise<ElicitResult> => await decision.promise);
    const fake = createClient();
    const interaction = new McpTaskInteraction({
      client: fake.client,
      elicitation: { form: true, handle, url: false },
      scope,
    });
    await interaction.start(['task-1']);
    const first = fake.handler()(inputRequiredTask('task-1'));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    const changed = inputRequiredTask('task-1');

    await expect(
      fake.handler()({
        ...changed,
        inputRequests: {
          approval: {
            ...changed.inputRequests.approval,
            params: {
              ...changed.inputRequests.approval.params,
              message: 'A different request under the same key',
            },
          },
        },
      })
    ).rejects.toThrow(/reused input key/u);
    expect(handle).toHaveBeenCalledTimes(1);

    decision.resolve({ action: 'decline' });
    await first;
    expect(fake.requestExtension).toHaveBeenCalledTimes(1);
    await interaction.close();
  });

  it('retries a failed response delivery without presenting the input again', async () => {
    const fake = createClient();
    fake.requestExtension.mockRejectedValueOnce(new Error('transient update failure'));
    const handle = vi.fn(async (): Promise<ElicitResult> => ({ action: 'decline' }));
    const interaction = new McpTaskInteraction({
      client: fake.client,
      elicitation: { form: true, handle, url: false },
      scope,
    });
    await interaction.start(['task-1']);

    await expect(fake.handler()(inputRequiredTask('task-1'))).rejects.toThrow(
      /transient update failure/u
    );
    await expect(fake.handler()(inputRequiredTask('task-1'))).resolves.toBeUndefined();

    expect(handle).toHaveBeenCalledTimes(1);
    expect(fake.requestExtension).toHaveBeenCalledTimes(2);
    await interaction.close();
  });

  it('fails visibly for an unsupported task input method without invoking consent', async () => {
    const handle = vi.fn(async (): Promise<ElicitResult> => ({ action: 'decline' }));
    const fake = createClient();
    const interaction = new McpTaskInteraction({
      client: fake.client,
      elicitation: { form: true, handle, url: false },
      scope,
    });
    await interaction.start(['task-1']);

    await expect(
      fake.handler()({
        ...inputRequiredTask('task-1'),
        inputRequests: {
          roots: { method: 'roots/list', params: {} },
        },
      })
    ).rejects.toThrow(/unsupported.*roots\/list/iu);
    expect(handle).not.toHaveBeenCalled();
    expect(fake.requestExtension).not.toHaveBeenCalled();
    await interaction.close();
  });

  it.each(['completed', 'failed'] as const)(
    'rejects cancellation when the remote task reaches %s',
    async (status) => {
      const fake = createClient();
      const interaction = new McpTaskInteraction({
        client: fake.client,
        elicitation: {
          form: true,
          handle: vi.fn(async () => ({ action: 'cancel' })),
          url: false,
        },
        scope,
      });
      await interaction.start(['task-1']);
      const cancellation = interaction.cancel('task-1');
      await vi.waitFor(() => expect(fake.requestExtension).toHaveBeenCalledTimes(1));

      await fake.handler()(taskStatus('task-1', status));

      await expect(cancellation).rejects.toEqual(
        new McpTaskCancellationOutcomeError('task-1', status)
      );
      await interaction.close();
    }
  );

  it('fences an abort-ignorant elicitation callback from a stale generation', async () => {
    const staleDecision = deferred<ElicitResult>();
    const staleFake = createClient();
    const staleInteraction = new McpTaskInteraction({
      client: staleFake.client,
      elicitation: {
        form: true,
        handle: vi.fn(async () => await staleDecision.promise),
        url: false,
      },
      scope,
    });
    await staleInteraction.start(['task-1']);
    const staleHandler = staleFake.handler();
    const staleInput = staleHandler(inputRequiredTask('task-1'));

    await staleInteraction.close();
    await expect(staleInput).rejects.toThrow(/closed/u);
    expect(staleFake.activeListeners()).toBe(0);

    const currentFake = createClient();
    const currentHandle = vi.fn(async (): Promise<ElicitResult> => ({ action: 'decline' }));
    const currentInteraction = new McpTaskInteraction({
      client: currentFake.client,
      elicitation: { form: true, handle: currentHandle, url: false },
      scope: { ...scope, generation: scope.generation + 1 },
    });
    await currentInteraction.start(['task-1']);
    await currentFake.handler()(inputRequiredTask('task-1'));
    expect(currentHandle.mock.calls[0]?.[1]).toMatchObject({ generation: scope.generation + 1 });

    staleDecision.resolve({ action: 'accept', content: { approved: true } });
    await Promise.resolve();
    expect(staleFake.requestExtension).not.toHaveBeenCalled();
    expect(currentFake.requestExtension).toHaveBeenCalledTimes(1);
    await currentInteraction.close();
  });

  it('fences a pending input callback when the remote task becomes terminal', async () => {
    const decision = deferred<ElicitResult>();
    const fake = createClient();
    const interaction = new McpTaskInteraction({
      client: fake.client,
      elicitation: {
        form: true,
        handle: vi.fn(async () => await decision.promise),
        url: false,
      },
      scope,
    });
    await interaction.start(['task-1']);
    const input = fake.handler()(inputRequiredTask('task-1'));

    await fake.handler()(taskStatus('task-1', 'completed'));

    await expect(input).rejects.toThrow(/terminal/u);
    decision.resolve({ action: 'accept', content: { approved: true } });
    await Promise.resolve();
    expect(fake.requestExtension).not.toHaveBeenCalled();
    await interaction.close();
  });

  it('closes while an abort-ignorant cancellation request remains unresolved', async () => {
    const acknowledgement = deferred<unknown>();
    const fake = createClient();
    fake.requestExtension.mockImplementationOnce(async () => await acknowledgement.promise);
    const interaction = new McpTaskInteraction({
      client: fake.client,
      elicitation: {
        form: true,
        handle: vi.fn(async () => ({ action: 'cancel' })),
        url: false,
      },
      scope,
    });
    await interaction.start(['task-1']);
    const cancellation = interaction.cancel('task-1');
    await vi.waitFor(() => expect(fake.requestExtension).toHaveBeenCalledTimes(1));

    await interaction.close();

    await expect(cancellation).rejects.toThrow(/closed/u);
    expect(fake.activeListeners()).toBe(0);
    expect(interaction.snapshot()).toEqual({
      activeCancellations: 0,
      activeInputs: 0,
      inputKeys: 0,
      subscriptionActive: false,
    });
    acknowledgement.resolve({ resultType: 'complete' });
  });

  it('drops ownership immediately when the notification subscription closes remotely', async () => {
    const fake = createClient();
    const interaction = new McpTaskInteraction({
      client: fake.client,
      elicitation: {
        form: true,
        handle: vi.fn(async () => ({ action: 'decline' })),
        url: false,
      },
      scope,
    });
    await interaction.start(['task-1']);
    expect(interaction.snapshot().subscriptionActive).toBe(true);

    fake.endSubscription();
    await vi.waitFor(() => expect(interaction.snapshot().subscriptionActive).toBe(false));

    expect(fake.activeListeners()).toBe(0);
    await expect(interaction.observe(taskStatus('task-1', 'working'))).rejects.toThrow(
      /subscription closed/u
    );
    await interaction.close();
  });
});
