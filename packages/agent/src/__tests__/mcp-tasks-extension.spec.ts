import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
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
  it('releases a rejected notification lease so the connection can listen again', async () => {
    const firstClosed = Promise.withResolvers<'remote'>();
    const secondClosed = Promise.withResolvers<'local'>();
    const listen = vi
      .fn()
      .mockResolvedValueOnce({ close: vi.fn(async () => undefined), closed: firstClosed.promise })
      .mockResolvedValueOnce({ close: vi.fn(async () => undefined), closed: secondClosed.promise });
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
    expect(accepted.value).toMatchObject({ resultType: 'complete', taskId: 'task-1' });
    expect(rejected.issues).toBeDefined();
  });
});
