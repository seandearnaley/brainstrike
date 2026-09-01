import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_TASKS_EXTENSION_ID as TEST_EXTENSION_ID,
  MCP_TASKS_EXTENSION_SETTINGS as TEST_EXTENSION_SETTINGS,
} from '@brainstrike/mcp-tasks-extension';
import { afterEach, expect, it } from 'vitest';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';
import {
  MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
  MCP_TASKS_CANCEL_REQUEST_CONTRACT,
  MCP_TASKS_UPDATE_REQUEST_CONTRACT,
  registerMcpTasksWireContracts,
  MCP_TASKS_GET_REQUEST_CONTRACT as TEST_EXTENSION_REQUEST,
} from '../mcp/tasks-extension';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/mcp-modern-extension-stdio-server.mjs', import.meta.url)
);
const cleanupTasks: Array<() => Promise<void>> = [];

function createTasksExtension() {
  const registry = new McpClientExtensionRegistry();
  registerMcpTasksWireContracts(registry);
  return registry;
}

afterEach(async () => {
  const results = await Promise.allSettled(
    cleanupTasks
      .splice(0)
      .reverse()
      .map((task) => task())
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Pinned-modern stdio extension cleanup failed');
  }
});

it('runs the exact Tasks extension contracts on a spawned modern stdio wire', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brainstrike-mcp-modern-extension-'));
  cleanupTasks.push(() => rm(directory, { force: true, recursive: true }));
  const requestsFile = join(directory, 'requests.jsonl');
  const registry = createTasksExtension();
  const client = new ExplicitStdioMcpClient({
    args: [FIXTURE_PATH],
    command: process.execPath,
    env: { BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE: requestsFile },
    extensionRegistry: registry,
    name: 'registered-modern-stdio-request-canary',
    protocol: '2026-07-28',
  });
  cleanupTasks.push(() => client.close());
  await expect(
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'task-stdio-123' })
  ).resolves.toMatchObject({ status: 'working', taskId: 'task-stdio-123' });
  await expect(
    client.requestExtension(MCP_TASKS_UPDATE_REQUEST_CONTRACT, {
      inputResponses: { roots: { resultType: 'complete', roots: [] } },
      taskId: 'task-stdio-123',
    })
  ).resolves.toEqual({ resultType: 'complete' });
  await expect(
    client.requestExtension(MCP_TASKS_CANCEL_REQUEST_CONTRACT, {
      taskId: 'task-stdio-123',
    })
  ).resolves.toEqual({ resultType: 'complete' });
  await expect(
    client.requestExtension(MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT, {
      arguments: {},
      name: 'sync-tool',
    })
  ).resolves.toMatchObject({ content: [] });
  await expect(
    client.requestExtension(MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT, {
      arguments: {},
      name: 'deferred-tool',
    })
  ).resolves.toMatchObject({ resultType: 'task', taskId: 'task-stdio-123' });

  const notification = Promise.withResolvers<void>();
  const subscription = await client.listenTasks(['task-stdio-123'], (task) => {
    expect(task).toMatchObject({ status: 'completed', taskId: 'task-stdio-123' });
    notification.resolve();
  });
  await notification.promise;
  await subscription.close();
  await expect(subscription.closed).resolves.toBe('local');

  const requests = (await readFile(requestsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(requests.map((request) => request['method']).join(',')).toBe(
    'server/discover,tasks/get,tasks/update,tasks/cancel,tools/call,tools/call,subscriptions/listen,notifications/cancelled'
  );
  expect(requests[1]).toMatchObject({
    method: 'tasks/get',
    params: {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS },
        },
      },
      taskId: 'task-stdio-123',
    },
  });
  expect(requests[2]).not.toHaveProperty('params.task');
  expect(requests[6]).toMatchObject({
    method: 'subscriptions/listen',
    params: { notifications: { taskIds: ['task-stdio-123'] } },
  });
});
