import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';
import {
  createDeferredTestExtension,
  TEST_EXTENSION_ID,
  TEST_EXTENSION_REQUEST,
  TEST_EXTENSION_SETTINGS,
} from './fixtures/mcp-client-extension-registry';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Pinned-modern HTTP MCP test cleanup failed');
  }
});

function createRequestExtensionServer(): ReturnType<typeof createMcpHandler> {
  return createMcpHandler(
    () => {
      const server = new McpServer(
        { name: 'modern-request-extension-server', version: '1.0.0' },
        { capabilities: { extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS } } }
      );
      server.server.setRequestHandler(
        'com.example/tasks-get-fixture',
        {
          params: TEST_EXTENSION_REQUEST.paramsSchema,
          result: TEST_EXTENSION_REQUEST.resultSchema,
        },
        ({ taskId }) => ({ status: 'working', taskId })
      );
      return server;
    },
    { legacy: 'reject' }
  );
}

it('projects registered extensions onto pinned-modern Streamable HTTP requests', async () => {
  const handler = createMcpHandler(
    () => new McpServer({ name: 'modern-capabilities-server', version: '1.0.0' }),
    { legacy: 'reject' }
  );
  cleanupTasks.push(() => handler.close());
  const extension = createDeferredTestExtension();
  const requests: unknown[] = [];
  const client = new ExplicitHttpMcpClient({
    extensionRegistry: extension.registry,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(await request.clone().json());
      return handler.fetch(request);
    },
    name: 'pinned-modern-capabilities-canary',
    protocol: '2026-07-28',
    transport: 'streamable-http',
    url: 'http://mcp-modern.invalid/mcp',
  });
  cleanupTasks.push(() => client.close());
  extension.register();

  await client.connect();

  expect(extension.registerAnother).toThrow('sealed');

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS },
        },
      },
    },
  });
});

it('sends a registered historical method on the exact modern wire with Mcp-Name', async () => {
  const handler = createRequestExtensionServer();
  cleanupTasks.push(() => handler.close());
  const extension = createDeferredTestExtension();
  const requests: Array<{ body: unknown; headers: Headers }> = [];
  const client = new ExplicitHttpMcpClient({
    extensionRegistry: extension.registry,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.clone().json();
      requests.push({ body, headers: new Headers(request.headers) });
      if (
        typeof body === 'object' &&
        body !== null &&
        'method' in body &&
        body.method === TEST_EXTENSION_REQUEST.method
      ) {
        const headers = new Headers(request.headers);
        headers.set('mcp-method', 'com.example/tasks-get-fixture');
        headers.delete('mcp-name');
        return handler.fetch(
          new Request(request, {
            body: JSON.stringify({ ...body, method: 'com.example/tasks-get-fixture' }),
            headers,
          })
        );
      }
      return handler.fetch(request);
    },
    name: 'registered-modern-request-canary',
    protocol: '2026-07-28',
    transport: 'streamable-http',
    url: 'http://mcp-modern.invalid/mcp',
  });
  cleanupTasks.push(() => client.close());
  extension.register();

  await expect(
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'task-123' })
  ).resolves.toMatchObject({ status: 'working', taskId: 'task-123' });
  await expect(
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'tâsk-雪' })
  ).resolves.toMatchObject({ status: 'working', taskId: 'tâsk-雪' });

  const extensionRequests = requests.filter(
    ({ body }) =>
      typeof body === 'object' &&
      body !== null &&
      'method' in body &&
      body.method === TEST_EXTENSION_REQUEST.method
  );
  expect(extensionRequests).toHaveLength(2);
  expect(extensionRequests[0]?.headers.get('mcp-method')).toBe('tasks/get');
  expect(extensionRequests[0]?.headers.get('mcp-name')).toBe('task-123');
  expect(extensionRequests[1]?.headers.get('mcp-name')).toBe('=?base64?dMOic2st6Zuq?=');
  expect(JSON.stringify(requests.map(({ body }) => body))).not.toContain(
    'io.brainstrike/registered-extension/'
  );
});

it('rejects registered extension dispatch over SSE before opening a transport', async () => {
  const extension = createDeferredTestExtension();
  let fetchCalled = false;
  const client = new ExplicitHttpMcpClient({
    extensionRegistry: extension.registry,
    fetch: async () => {
      fetchCalled = true;
      throw new Error('SSE transport must not open');
    },
    name: 'registered-extension-sse-rejection-canary',
    protocol: 'legacy',
    transport: 'sse',
    url: 'http://mcp-modern.invalid/sse',
  });
  cleanupTasks.push(() => client.close());
  extension.register();

  await expect(
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'task-123' })
  ).rejects.toThrow('requires the streamable-http transport');
  expect(fetchCalled).toBe(false);
});
