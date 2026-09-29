import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_APPS_CLIENT_CAPABILITY,
  MCP_APPS_EXTENSION_ID,
} from '@brainstrike/mcp-app-host/capabilities';
import {
  MCP_TASKS_EXTENSION_ID as TEST_EXTENSION_ID,
  MCP_TASKS_EXTENSION_SETTINGS as TEST_EXTENSION_SETTINGS,
} from '@brainstrike/mcp-tasks-extension';
import { afterEach, expect, it, vi } from 'vitest';
import { registerMcpAppsClientCapability } from '../mcp/apps-extension';
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
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const cleanupTasks: Array<() => Promise<void>> = [];

function createTasksExtension() {
  const registry = new McpClientExtensionRegistry();
  registerMcpTasksWireContracts(registry);
  return registry;
}

function createAppsExtension() {
  const registry = new McpClientExtensionRegistry();
  registerMcpAppsClientCapability(registry);
  return registry;
}

async function readRecordedRequests(requestsFile: string): Promise<Record<string, unknown>[]> {
  return (await readFile(requestsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readAdvertisedClientCapabilities(
  request: Record<string, unknown> | undefined
): Record<string, unknown> {
  const params = request?.['params'];
  if (typeof params !== 'object' || params === null) {
    throw new Error('Recorded request has no params object');
  }
  const meta = Reflect.get(params, '_meta');
  if (typeof meta !== 'object' || meta === null) {
    throw new Error('Recorded request has no _meta object');
  }
  const capabilities = Reflect.get(meta, CLIENT_CAPABILITIES_META_KEY);
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new Error('Recorded request advertises no client capabilities');
  }
  return capabilities as Record<string, unknown>;
}

async function cleanupAfterTest(): Promise<void> {
  const tasks = cleanupTasks.splice(0).reverse();
  const failures: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Pinned-modern stdio extension cleanup failed');
  }
}

afterEach(cleanupAfterTest);

it('awaits each wire cleanup in reverse acquisition order', async () => {
  const closed = Promise.withResolvers<void>();
  const events: string[] = [];
  cleanupTasks.push(async () => {
    events.push('remove directory');
  });
  cleanupTasks.push(async () => {
    events.push('close client');
    await closed.promise;
    events.push('client closed');
  });

  const cleanup = cleanupAfterTest();
  try {
    expect([...events]).toEqual(['close client']);
  } finally {
    closed.resolve();
    await cleanup;
  }
  expect(events).toEqual(['close client', 'client closed', 'remove directory']);
  await cleanupAfterTest();
  expect(events).toHaveLength(3);
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

  await vi.waitFor(async () => {
    const methods = (await readFile(requestsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as Record<string, unknown>)['method']);
    expect(methods.at(-1)).toBe('notifications/cancelled');
  });

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

it('advertises no extensions and dispatches none on a modern stdio wire with both dials off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brainstrike-mcp-modern-extension-off-'));
  cleanupTasks.push(() => rm(directory, { force: true, recursive: true }));
  const requestsFile = join(directory, 'requests.jsonl');
  const client = new ExplicitStdioMcpClient({
    args: [FIXTURE_PATH],
    command: process.execPath,
    env: { BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE: requestsFile },
    name: 'extensions-disabled-modern-stdio-canary',
    protocol: '2026-07-28',
  });
  cleanupTasks.push(() => client.close());

  await expect(client.callTool({ arguments: {}, name: 'sync-tool' })).resolves.toMatchObject({
    content: [],
  });
  await expect(
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'task-stdio-123' })
  ).rejects.toThrow('requires an extension registry');
  await expect(client.listenTasks(['task-stdio-123'], () => undefined)).rejects.toThrow(
    'require an extension registry'
  );
  await expect(client.callTool({ arguments: {}, name: 'sync-tool' })).resolves.toMatchObject({
    content: [],
  });

  const requests = await readRecordedRequests(requestsFile);
  expect(requests.map((request) => request['method']).join(',')).toBe(
    'server/discover,tools/list,tools/call,tools/call'
  );
  expect(requests[0]).toMatchObject({ method: 'server/discover' });
  for (const request of requests) {
    expect(Object.keys(readAdvertisedClientCapabilities(request))).not.toContain('extensions');
  }
  expect(JSON.stringify(requests)).not.toContain(TEST_EXTENSION_ID);
  expect(JSON.stringify(requests)).not.toContain(MCP_APPS_EXTENSION_ID);
});

it('advertises only Apps and keeps every Tasks method off a modern stdio wire', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brainstrike-mcp-modern-extension-apps-only-'));
  cleanupTasks.push(() => rm(directory, { force: true, recursive: true }));
  const requestsFile = join(directory, 'requests.jsonl');
  const client = new ExplicitStdioMcpClient({
    args: [FIXTURE_PATH],
    command: process.execPath,
    env: { BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE: requestsFile },
    extensionRegistry: createAppsExtension(),
    name: 'apps-only-modern-stdio-canary',
    protocol: '2026-07-28',
  });
  cleanupTasks.push(() => client.close());

  await expect(client.callTool({ arguments: {}, name: 'sync-tool' })).resolves.toMatchObject({
    content: [],
  });
  await expect(
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'task-stdio-123' })
  ).rejects.toThrow('is not registered');
  await expect(client.listenTasks(['task-stdio-123'], () => undefined)).rejects.toThrow(
    'is not registered'
  );
  await expect(client.callTool({ arguments: {}, name: 'sync-tool' })).resolves.toMatchObject({
    content: [],
  });

  const requests = await readRecordedRequests(requestsFile);
  expect(requests.map((request) => request['method']).join(',')).toBe(
    'server/discover,tools/list,tools/call,tools/call'
  );
  expect(requests[0]).toMatchObject({ method: 'server/discover' });
  for (const request of requests) {
    const extensions = readAdvertisedClientCapabilities(request)['extensions'];
    expect(extensions).toEqual({ [MCP_APPS_EXTENSION_ID]: MCP_APPS_CLIENT_CAPABILITY });
    expect(Object.keys(extensions as Record<string, unknown>)).not.toContain(TEST_EXTENSION_ID);
  }
  expect(JSON.stringify(requests)).not.toContain(TEST_EXTENSION_ID);
});
