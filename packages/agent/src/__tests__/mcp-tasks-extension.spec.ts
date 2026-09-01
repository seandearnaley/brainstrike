import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import {
  McpClientExtensionRegistry,
  REGISTERED_EXTENSION_RESULT_KEY,
} from '../mcp/client-extension-registry';
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

describe('MCP Tasks wire adapter', () => {
  it('rejects task notification acknowledgements outside the requested subset', async () => {
    const close = vi.fn(async () => undefined);
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen: vi.fn(async () => ({
        close,
        closed: new Promise<never>(() => undefined),
        honoredFilter: { taskIds: ['task-foreign'] },
      })),
      removeNotificationHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
    } as unknown as Client;

    await expect(listenForMcpTasks(client, tasksRegistry(), ['task-1'], vi.fn())).rejects.toThrow(
      /outside the requested task ids/u
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releases a rejected notification lease so the connection can listen again', async () => {
    const firstClosed = Promise.withResolvers<'remote'>();
    const secondClosed = Promise.withResolvers<'local'>();
    const listen = vi
      .fn()
      .mockResolvedValueOnce({
        close: vi.fn(async () => undefined),
        closed: firstClosed.promise,
        honoredFilter: { taskIds: ['task-1'] },
      })
      .mockResolvedValueOnce({
        close: vi.fn(async () => undefined),
        closed: secondClosed.promise,
        honoredFilter: { taskIds: ['task-2'] },
      });
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
    const first = await listenForMcpTasks(client, registry, ['task-1'], vi.fn());
    const failure = new Error('remote subscription failed');
    firstClosed.reject(failure);

    await expect(first.closed).rejects.toBe(failure);
    const second = await listenForMcpTasks(client, registry, ['task-2'], vi.fn());
    expect(setNotificationHandler).toHaveBeenNthCalledWith(
      2,
      MCP_TASKS_STATUS_NOTIFICATION_CONTRACT.method,
      { params: MCP_TASKS_STATUS_NOTIFICATION_CONTRACT.paramsSchema },
      expect.any(Function)
    );
    await second.close();
    expect(removeNotificationHandler).toHaveBeenCalledTimes(2);
  });

  it('rejects an absent or conflicting complete discriminator on exact 2026 task results', async () => {
    const complete = {
      createdAt: '2026-08-31T20:00:00Z',
      lastUpdatedAt: '2026-08-31T20:00:01Z',
      status: 'working',
      taskId: 'task-1',
      ttlMs: null,
    };
    const wrap = (value: unknown) => ({ [REGISTERED_EXTENSION_RESULT_KEY]: value });
    const accepted = await MCP_TASKS_GET_REQUEST_CONTRACT.resultSchema['~standard'].validate(
      wrap({ ...complete, resultType: 'complete' })
    );
    const missing = await MCP_TASKS_GET_REQUEST_CONTRACT.resultSchema['~standard'].validate(
      wrap(complete)
    );
    const rejected = await MCP_TASKS_GET_REQUEST_CONTRACT.resultSchema['~standard'].validate({
      [REGISTERED_EXTENSION_RESULT_KEY]: { ...complete, resultType: 'task' },
    });

    expect(accepted.issues).toBeUndefined();
    expect(missing.issues).toBeDefined();
    expect(rejected.issues).toBeDefined();
  });
});
