import {
  MCP_TASKS_EXTENSION_ID as TEST_EXTENSION_ID,
  MCP_TASKS_EXTENSION_SETTINGS as TEST_EXTENSION_SETTINGS,
} from '@brainstrike/mcp-tasks-extension';
import type { AuthProvider } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';
import {
  registerMcpTasksWireContracts,
  MCP_TASKS_GET_REQUEST_CONTRACT as TEST_EXTENSION_REQUEST,
} from '../mcp/tasks-extension';

const cleanupTasks: Array<() => Promise<void>> = [];

function createTasksExtension() {
  const registry = new McpClientExtensionRegistry();
  return {
    register: () => registerMcpTasksWireContracts(registry),
    registry,
  };
}

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
        ({ taskId }) => {
          if (taskId === 'missing') {
            throw new Error('Task not found');
          }
          return {
            createdAt: '2026-08-31T20:00:00Z',
            lastUpdatedAt: '2026-08-31T20:00:01Z',
            resultType: 'complete' as const,
            status: 'working' as const,
            taskId,
            ttlMs: null,
          };
        }
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
  const extension = createTasksExtension();
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

  await expect(
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'task-123' })
  ).rejects.toThrow('does not advertise extension');

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

it('sends the exact Tasks method on the modern wire with Mcp-Name', async () => {
  const handler = createRequestExtensionServer();
  cleanupTasks.push(() => handler.close());
  const extension = createTasksExtension();
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
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'missing' })
  ).rejects.toThrow();

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
  expect(JSON.stringify(requests.map(({ body }) => body))).not.toContain(
    'io.brainstrike/registered-extension/'
  );
});

it('leaves core legacy traffic and its 401 re-auth retry untouched with Tasks registered', async () => {
  const extension = createTasksExtension();
  const observed: Array<{ authorization: string | null; method: string; wire: string | null }> = [];
  let token = 'expired-token';
  let unauthorizedCalls = 0;
  const authProvider: AuthProvider = {
    async onUnauthorized() {
      unauthorizedCalls += 1;
      token = 'current-token';
    },
    async token() {
      return token;
    },
  };
  const client = new ExplicitHttpMcpClient({
    authProvider,
    extensionRegistry: extension.registry,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const wire = request.headers.get('mcp-method');
      const authorization = request.headers.get('authorization');
      if (request.method !== 'POST') {
        observed.push({ authorization, method: request.method, wire });
        return new Response(null, { status: request.method === 'GET' ? 405 : 200 });
      }
      const body = (await request.json()) as { id?: number; method: string };
      observed.push({ authorization, method: body.method, wire });
      if (authorization !== 'Bearer current-token') {
        return new Response(null, {
          headers: {
            'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1/oauth-resource"',
          },
          status: 401,
        });
      }
      if (body.method === 'initialize') {
        return Response.json(
          {
            id: body.id,
            jsonrpc: '2.0',
            result: {
              capabilities: { tools: {} },
              protocolVersion: '2025-11-25',
              serverInfo: { name: 'legacy-core-server', version: '1.0.0' },
            },
          },
          { headers: { 'mcp-session-id': 'session-1' } }
        );
      }
      if (body.method === 'tools/call') {
        return Response.json({
          id: body.id,
          jsonrpc: '2.0',
          result: { content: [{ text: 'ok', type: 'text' }] },
        });
      }
      return new Response(null, { status: 202 });
    },
    name: 'registered-legacy-core-canary',
    protocol: 'legacy',
    transport: 'streamable-http',
    url: 'http://mcp-legacy.invalid/mcp',
  });
  cleanupTasks.push(() => client.close());
  extension.register();

  await client.connect();
  expect(unauthorizedCalls).toBe(1);
  await expect(client.callTool({ arguments: {}, name: 'write' })).resolves.toMatchObject({
    content: [{ text: 'ok', type: 'text' }],
  });
  await client.close();

  expect(observed.map(({ method }) => method)).toEqual([
    'initialize',
    'initialize',
    'notifications/initialized',
    'GET',
    'tools/call',
    'DELETE',
  ]);
  expect(observed.every(({ wire }) => wire === null)).toBe(true);
});

it('rejects registered extension dispatch over SSE before opening a transport', async () => {
  const extension = createTasksExtension();
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
