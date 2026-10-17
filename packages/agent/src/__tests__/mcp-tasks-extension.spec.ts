import { type Client, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
import { RegisteredExtensionDispatchLedger } from '../mcp/registered-extension-dispatch';
import {
  listenForMcpTasks,
  MCP_TASKS_GET_REQUEST_CONTRACT,
  MCP_TASKS_STATUS_NOTIFICATION_CONTRACT,
  registerMcpTasksWireContracts,
} from '../mcp/tasks-extension';

function tasksRegistry(): McpClientExtensionRegistry {
  const registry = new McpClientExtensionRegistry();
  registerMcpTasksWireContracts(registry);
  return registry;
}

/**
 * Stands in for the transport dispatch bridge: binds the outgoing listen filter
 * to a request id and records the server's RAW acknowledgement against it, which
 * is the only place an extension field like `taskIds` survives (the SDK strips it
 * from `McpSubscription.honoredFilter`).
 */
function acknowledgingListen<Subscription>(
  ledger: RegisteredExtensionDispatchLedger,
  acknowledgements: readonly unknown[],
  subscribe: (attempt: number) => Subscription
) {
  const scope = ledger.openTransportScope();
  let attempt = 0;
  return vi.fn(async (filter: unknown) => {
    const index = attempt;
    attempt += 1;
    const subscriptionId = `listen:${index}`;
    scope.bindSubscriptionRequest(subscriptionId, { notifications: filter });
    const acknowledgement = acknowledgements[index];
    if (acknowledgement !== undefined) {
      scope.recordSubscriptionAcknowledgement({
        _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
        notifications: acknowledgement,
      });
    }
    return subscribe(index);
  });
}

describe('MCP Tasks wire adapter', () => {
  it('rolls back active ownership when notification handler registration throws', async () => {
    const setNotificationHandler = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('handler registration failed');
      })
      .mockImplementationOnce(() => undefined);
    const subscription = {
      close: vi.fn(async () => undefined),
      closed: new Promise<never>(() => undefined),
      honoredFilter: {},
    };
    const ledger = new RegisteredExtensionDispatchLedger();
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen: acknowledgingListen(
        ledger,
        [{ taskIds: ['task-1'] }, { taskIds: ['task-1'] }],
        () => subscription
      ),
      removeNotificationHandler: vi.fn(),
      setNotificationHandler,
    } as unknown as Client;
    const registry = tasksRegistry();

    await expect(listenForMcpTasks(client, registry, ledger, ['task-1'], vi.fn())).rejects.toThrow(
      /handler registration failed/u
    );
    const lease = await listenForMcpTasks(client, registry, ledger, ['task-1'], vi.fn());

    expect(setNotificationHandler).toHaveBeenCalledTimes(2);
    expect(lease.honoredTaskIds).toEqual(['task-1']);
    await lease.close();
  });

  it('rolls back active ownership when the acknowledgement claim throws', async () => {
    // Review of #2928: the capture claim sat outside the rollback the rest of the
    // function is careful about, so a throw here leaked the notification handler
    // AND the per-connection lease, and the connection could never listen again.
    const subscription = {
      close: vi.fn(async () => undefined),
      closed: new Promise<never>(() => undefined),
      honoredFilter: {},
    };
    const ledger = new RegisteredExtensionDispatchLedger();
    const capture = vi.spyOn(ledger, 'captureSubscriptionAcknowledgement');
    capture.mockImplementationOnce(() => {
      throw new Error('MCP subscription acknowledgement filter is already claimed');
    });
    const removeNotificationHandler = vi.fn();
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen: acknowledgingListen(ledger, [{ taskIds: ['task-1'] }], () => subscription),
      removeNotificationHandler,
      setNotificationHandler: vi.fn(),
    } as unknown as Client;
    const registry = tasksRegistry();

    await expect(listenForMcpTasks(client, registry, ledger, ['task-1'], vi.fn())).rejects.toThrow(
      /filter is already claimed/u
    );
    expect(removeNotificationHandler).toHaveBeenCalledTimes(1);

    const lease = await listenForMcpTasks(client, registry, ledger, ['task-1'], vi.fn());
    expect(lease.honoredTaskIds).toEqual(['task-1']);
    await lease.close();
  });

  it('rejects task notification acknowledgements outside the requested subset', async () => {
    const close = vi.fn(async () => undefined);
    const ledger = new RegisteredExtensionDispatchLedger();
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen: acknowledgingListen(ledger, [{ taskIds: ['task-foreign'] }], () => ({
        close,
        closed: new Promise<never>(() => undefined),
        honoredFilter: {},
      })),
      removeNotificationHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
    } as unknown as Client;

    await expect(
      listenForMcpTasks(client, tasksRegistry(), ledger, ['task-1'], vi.fn())
    ).rejects.toThrow(/outside the requested task ids/u);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes and names the rejected ids when the server honors only a subset', async () => {
    // Review of #2913 (BST-1596): `listen()` resolves on ANY acknowledgement and
    // the SDK's `honoredFilter` has already dropped `taskIds`, so a partially
    // honored lease used to look active while it could never emit for the
    // unacknowledged task.
    const close = vi.fn(async () => undefined);
    const ledger = new RegisteredExtensionDispatchLedger();
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen: acknowledgingListen(ledger, [{ taskIds: ['task-1'] }], () => ({
        close,
        closed: new Promise<never>(() => undefined),
        honoredFilter: {},
      })),
      removeNotificationHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
    } as unknown as Client;

    await expect(
      listenForMcpTasks(client, tasksRegistry(), ledger, ['task-1', 'task-2'], vi.fn())
    ).rejects.toThrow(/rejected task ids: task-2/u);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('refuses a lease whose acknowledgement never reached the dispatch bridge', async () => {
    const close = vi.fn(async () => undefined);
    const ledger = new RegisteredExtensionDispatchLedger();
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen: acknowledgingListen(ledger, [], () => ({
        close,
        closed: new Promise<never>(() => undefined),
        honoredFilter: { taskIds: ['task-1'] },
      })),
      removeNotificationHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
    } as unknown as Client;

    await expect(
      listenForMcpTasks(client, tasksRegistry(), ledger, ['task-1'], vi.fn())
    ).rejects.toThrow(/never observed on this connection/u);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releases a rejected notification lease so the connection can listen again', async () => {
    const firstClosed = Promise.withResolvers<'remote'>();
    const secondClosed = Promise.withResolvers<'local'>();
    const ledger = new RegisteredExtensionDispatchLedger();
    const listen = acknowledgingListen(
      ledger,
      [{ taskIds: ['task-1'] }, { taskIds: ['task-2'] }],
      (attempt) => ({
        close: vi.fn(async () => undefined),
        closed: attempt === 0 ? firstClosed.promise : secondClosed.promise,
        honoredFilter: {},
      })
    );
    const removeNotificationHandler = vi.fn();
    const setNotificationHandler = vi.fn();
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen,
      removeNotificationHandler,
      setNotificationHandler,
    } as unknown as Client;
    const registry = tasksRegistry();
    const first = await listenForMcpTasks(client, registry, ledger, ['task-1'], vi.fn());
    const failure = new Error('remote subscription failed');
    firstClosed.reject(failure);

    await expect(first.closed).rejects.toBe(failure);
    const second = await listenForMcpTasks(client, registry, ledger, ['task-2'], vi.fn());
    expect(setNotificationHandler).toHaveBeenNthCalledWith(
      2,
      MCP_TASKS_STATUS_NOTIFICATION_CONTRACT.method,
      { params: MCP_TASKS_STATUS_NOTIFICATION_CONTRACT.paramsSchema },
      expect.any(Function)
    );
    await second.close();
    expect(removeNotificationHandler).toHaveBeenCalledTimes(2);
  });

  it('fills only an absent complete discriminator and rejects a conflicting server value', async () => {
    const complete = {
      createdAt: '2026-08-31T20:00:00Z',
      lastUpdatedAt: '2026-08-31T20:00:01Z',
      status: 'working',
      taskId: 'task-1',
      ttlMs: null,
    };
    const accepted =
      await MCP_TASKS_GET_REQUEST_CONTRACT.resultSchema['~standard'].validate(complete);
    const rejected = await MCP_TASKS_GET_REQUEST_CONTRACT.resultSchema['~standard'].validate({
      ...complete,
      resultType: 'task',
    });

    expect(accepted.issues).toBeUndefined();
    if (accepted.issues) {
      throw new Error('Expected a successful task result');
    }
    expect(accepted.value).toMatchObject({ resultType: 'complete', taskId: 'task-1' });
    expect(rejected.issues).toBeDefined();
  });
});
