import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';
import { registerMcpTasksWireContracts } from '../mcp/tasks-extension';

/**
 * BST-1596 wire proof: `Client.listen()` resolves on ANY
 * `notifications/subscriptions/acknowledged`, and the SDK settles
 * `McpSubscription.honoredFilter` from the CORE `SubscriptionFilter` schema —
 * which strips the Tasks extension's `taskIds`. Only the raw notification, read
 * at the registered-extension dispatch bridge, can tell an active lease from one
 * that will never emit for the task ids it asked for. These tests drive real
 * stdio and real Streamable HTTP servers whose acknowledgement honors all, some,
 * or none of the requested ids.
 */

type AckMode = 'empty' | 'full' | 'partial';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/mcp-modern-extension-stdio-server.mjs', import.meta.url)
);
const EXTENSION_ID = 'io.modelcontextprotocol/tasks';
const SERVER_INFO = { name: 'brainstrike-tasks-ack-fixture', version: '1.0.0' };
const cleanupTasks: Array<() => Promise<void>> = [];

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
    throw new AggregateError(failures, 'Tasks acknowledgement wire cleanup failed');
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

it('preserves the original cleanup failure and still releases earlier resources', async () => {
  const failure = new Error('client close failed');
  const releaseDirectory = vi.fn(async () => undefined);
  cleanupTasks.push(releaseDirectory);
  cleanupTasks.push(() => Promise.reject(failure));

  await expect(cleanupAfterTest()).rejects.toBe(failure);
  expect(releaseDirectory).toHaveBeenCalledTimes(1);
  await cleanupAfterTest();
  expect(releaseDirectory).toHaveBeenCalledTimes(1);
});

it('reports all synchronous and asynchronous cleanup failures in disposal order', async () => {
  const closeFailure = new Error('client close failed');
  const directoryFailure = new Error('directory removal failed');
  const releaseEarlierResource = vi.fn(async () => undefined);
  cleanupTasks.push(releaseEarlierResource);
  cleanupTasks.push(() => {
    throw directoryFailure;
  });
  cleanupTasks.push(() => Promise.reject(closeFailure));

  const cleanup = cleanupAfterTest();
  await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
  await expect(cleanup).rejects.toMatchObject({
    errors: [closeFailure, directoryFailure],
    message: 'Tasks acknowledgement wire cleanup failed',
  });
  expect(releaseEarlierResource).toHaveBeenCalledTimes(1);
  await cleanupAfterTest();
  expect(releaseEarlierResource).toHaveBeenCalledTimes(1);
});

function tasksRegistry(): McpClientExtensionRegistry {
  const registry = new McpClientExtensionRegistry();
  registerMcpTasksWireContracts(registry);
  return registry;
}

function honoredTaskIds(mode: AckMode, requested: readonly string[]): { taskIds?: string[] } {
  if (mode === 'empty') {
    return {};
  }
  return { taskIds: mode === 'partial' ? [...requested.slice(0, 1)] : [...requested] };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

function requestedTaskIds(body: Record<string, unknown>): readonly string[] {
  const params = body['params'];
  const notifications =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)['notifications']
      : undefined;
  const taskIds =
    typeof notifications === 'object' && notifications !== null
      ? (notifications as Record<string, unknown>)['taskIds']
      : undefined;
  return Array.isArray(taskIds) ? (taskIds as readonly string[]) : [];
}

function respondToListen(
  response: ServerResponse,
  body: Record<string, unknown>,
  mode: AckMode
): void {
  response.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream',
  });
  const acknowledged = {
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      _meta: { 'io.modelcontextprotocol/subscriptionId': body['id'] },
      notifications: honoredTaskIds(mode, requestedTaskIds(body)),
    },
  };
  response.write(`event: message\ndata: ${JSON.stringify(acknowledged)}\n\n`);
}

/** Minimal pinned-modern Streamable HTTP server: discover, listen, notifications. */
async function startTasksAckServer(mode: AckMode): Promise<URL> {
  const server: Server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const body = await readJsonBody(request);
    if (body['id'] === undefined) {
      response.writeHead(202).end();
      return;
    }
    if (body['method'] === 'server/discover') {
      writeJson(response, {
        id: body['id'],
        jsonrpc: '2.0',
        result: {
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          cacheScope: 'private',
          capabilities: { extensions: { [EXTENSION_ID]: {} }, tools: {} },
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          ttlMs: 0,
        },
      });
      return;
    }
    if (body['method'] === 'subscriptions/listen') {
      respondToListen(response, body, mode);
      return;
    }
    writeJson(response, {
      error: { code: -32_601, message: `Method not found: ${String(body['method'])}` },
      id: body['id'],
      jsonrpc: '2.0',
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  cleanupTasks.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  const address = server.address() as AddressInfo;
  return new URL('/mcp', `http://127.0.0.1:${address.port}`);
}

async function startStdioClient(mode: AckMode): Promise<ExplicitStdioMcpClient> {
  const directory = await mkdtemp(join(tmpdir(), 'brainstrike-mcp-tasks-ack-'));
  cleanupTasks.push(() => rm(directory, { force: true, recursive: true }));
  const client = new ExplicitStdioMcpClient({
    args: [FIXTURE_PATH],
    command: process.execPath,
    env: {
      BRAINSTRIKE_STDIO_TEST_ACK_MODE: mode,
      BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE: join(directory, 'requests.jsonl'),
    },
    extensionRegistry: tasksRegistry(),
    name: `tasks-ack-stdio-${mode}`,
    protocol: '2026-07-28',
  });
  cleanupTasks.push(() => client.close());
  return client;
}

async function startHttpClient(mode: AckMode): Promise<ExplicitHttpMcpClient> {
  const url = await startTasksAckServer(mode);
  const client = new ExplicitHttpMcpClient({
    extensionRegistry: tasksRegistry(),
    name: `tasks-ack-http-${mode}`,
    protocol: '2026-07-28',
    transport: 'streamable-http',
    url,
  });
  cleanupTasks.push(() => client.close());
  return client;
}

describe('MCP Tasks subscription acknowledgement over real stdio', () => {
  it('holds the lease when the server acknowledges every requested task id', async () => {
    const client = await startStdioClient('full');
    const lease = await client.listenTasks(['task-stdio-123'], vi.fn());

    expect(lease.honoredTaskIds).toEqual(['task-stdio-123']);
    await lease.close();
    await expect(lease.closed).resolves.toBe('local');
  });

  it('closes and rejects with the rejected ids on a partial acknowledgement', async () => {
    const client = await startStdioClient('partial');

    await expect(client.listenTasks(['task-stdio-123', 'task-stdio-456'], vi.fn())).rejects.toThrow(
      /rejected task ids: task-stdio-456/u
    );
  });

  it('closes and rejects every requested id on an empty acknowledgement', async () => {
    const client = await startStdioClient('empty');

    await expect(client.listenTasks(['task-stdio-123'], vi.fn())).rejects.toThrow(
      /rejected task ids: task-stdio-123/u
    );
  });
});

describe('MCP Tasks subscription acknowledgement over real Streamable HTTP', () => {
  it('holds the lease when the server acknowledges every requested task id', async () => {
    const client = await startHttpClient('full');
    const lease = await client.listenTasks(['task-http-123'], vi.fn());

    expect(lease.honoredTaskIds).toEqual(['task-http-123']);
    await lease.close();
  });

  it('closes and rejects with the rejected ids on a partial acknowledgement', async () => {
    const client = await startHttpClient('partial');

    await expect(client.listenTasks(['task-http-123', 'task-http-456'], vi.fn())).rejects.toThrow(
      /rejected task ids: task-http-456/u
    );
  });

  it('closes and rejects every requested id on an empty acknowledgement', async () => {
    const client = await startHttpClient('empty');

    await expect(client.listenTasks(['task-http-123'], vi.fn())).rejects.toThrow(
      /rejected task ids: task-http-123/u
    );
  });
});
