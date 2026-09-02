import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
import {
  listenForMcpTasks,
  MCP_TASKS_STATUS_NOTIFICATION_CONTRACT,
  registerMcpTasksWireContracts,
} from '../mcp/tasks-extension';

function tasksRegistry(): McpClientExtensionRegistry {
  const registry = new McpClientExtensionRegistry();
  registerMcpTasksWireContracts(registry);
  return registry;
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
      honoredFilter: { taskIds: ['task-1'] },
    };
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen: vi.fn(async () => subscription),
      removeNotificationHandler: vi.fn(),
      setNotificationHandler,
    } as unknown as Client;
    const registry = tasksRegistry();

    await expect(listenForMcpTasks(client, registry, ['task-1'], vi.fn())).rejects.toThrow(
      /handler registration failed/u
    );
    const lease = await listenForMcpTasks(client, registry, ['task-1'], vi.fn());

    expect(setNotificationHandler).toHaveBeenCalledTimes(2);
    await lease.close();
  });

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
});
