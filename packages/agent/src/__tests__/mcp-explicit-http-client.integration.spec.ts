// biome-ignore-all lint/style/noExcessiveLinesPerFile: real modern and legacy protocol fixtures are atomic lifecycle tests
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import {
  completable,
  createMcpHandler,
  McpServer,
  ResourceTemplate,
  type Transport,
} from '@modelcontextprotocol/server';
import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ExplicitHttpMcpClient,
  type ExplicitHttpMcpClientOptions,
  type ExplicitHttpMcpFetch,
} from '../mcp/explicit-http-client';
import {
  createDeferredTestExtension,
  TEST_EXTENSION_ID,
  TEST_EXTENSION_SETTINGS,
} from './fixtures/mcp-client-extension-registry';

interface RecordedRequest {
  body?: unknown;
  headers: IncomingMessage['headers'];
  method: string;
  pathname: string;
}

interface RunningServer {
  close: () => Promise<void>;
  url: URL;
}

interface ExpiringStatefulServer extends RunningServer {
  expireSession: (onExpiredRequest?: () => void) => void;
}

const cleanupTasks: Array<() => Promise<void>> = [];
const MCP_CONNECTION_CLOSED_PROTOCOL_CODE = -32_000;

afterEach(async () => {
  const tasks = cleanupTasks.splice(0).reverse();
  for (const cleanup of tasks) {
    await cleanup();
  }
});

function createEchoServer(): McpServer {
  const server = new McpServer({ name: 'explicit-http-test-server', version: '1.0.0' });

  server.registerTool(
    'echo',
    {
      description: 'Echo a value',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
    },
    async ({ value }) => ({
      content: [{ text: value, type: 'text' }],
      structuredContent: { echoed: value },
    })
  );
  server.registerTool('fail', { description: 'Return a tool error' }, async () => ({
    content: [{ text: 'intentional failure', type: 'text' }],
    isError: true,
  }));

  return server;
}

function createCoreFeatureServer(): McpServer {
  const server = new McpServer({ name: 'core-feature-test-server', version: '1.0.0' });
  server.registerTool('search', { description: 'Search issues' }, async () => ({ content: [] }));
  server.registerResource(
    'BST-1471',
    'linear://issue/BST-1471',
    {
      cacheHint: { cacheScope: 'private', ttlMs: 1000 },
      description: 'Issue body',
      mimeType: 'text/markdown',
      title: 'MCP core server features',
    },
    async (uri) => ({
      contents: [
        { mimeType: 'text/markdown', text: '# BST-1471', uri: uri.href },
        {
          blob: 'AAEC',
          mimeType: 'application/octet-stream',
          uri: 'linear://issue/BST-1471/attachment',
        },
      ],
    })
  );
  server.registerResource(
    'issue',
    new ResourceTemplate('linear://issue/{identifier}', {
      complete: {
        identifier: (value) => ['BST-1471', 'BST-1472'].filter((id) => id.startsWith(value)),
      },
      list: undefined,
    }),
    { description: 'Issue by identifier', mimeType: 'text/markdown', title: 'Issue' },
    async (uri) => ({ contents: [{ text: uri.href, uri: uri.href }] })
  );
  server.registerPrompt(
    'summarize-issue',
    {
      argsSchema: z.object({
        identifier: z.string(),
        tone: completable(z.string(), (value) =>
          ['formal', 'friendly'].filter((tone) => tone.startsWith(value))
        ),
      }),
      description: 'Summarize one issue',
      title: 'Summarize issue',
    },
    ({ identifier, tone }) => ({
      description: 'A mixed-content prompt',
      messages: [
        {
          content: { text: `Write a ${tone} summary for ${identifier}.`, type: 'text' },
          role: 'user',
        },
        {
          content: { data: 'aW1hZ2U=', mimeType: 'image/png', type: 'image' },
          role: 'assistant',
        },
        {
          content: {
            name: identifier,
            type: 'resource_link',
            uri: `linear://issue/${identifier}`,
          },
          role: 'assistant',
        },
        {
          content: {
            resource: {
              mimeType: 'text/markdown',
              text: `# ${identifier}`,
              uri: `linear://issue/${identifier}`,
            },
            type: 'resource',
          },
          role: 'assistant',
        },
      ],
    })
  );
  server.server.registerCapabilities({
    prompts: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    tools: { listChanged: true },
  });
  server.server.setRequestHandler('resources/subscribe', async () => ({}));
  server.server.setRequestHandler('resources/unsubscribe', async () => ({}));
  return server;
}

async function listen(server: Server, pathname: string): Promise<RunningServer> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = new URL(pathname, `http://127.0.0.1:${address.port}`);
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };
  cleanupTasks.push(close);

  return { close, url };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function requestMethod(body: unknown): string | undefined {
  if (!(body && typeof body === 'object' && 'method' in body)) {
    return;
  }
  return typeof body.method === 'string' ? body.method : undefined;
}
function requestCount(requests: readonly RecordedRequest[], method: string): number {
  return requests.filter((request) => requestMethod(request.body) === method).length;
}
async function startStreamableServer(options: {
  failInitializations?: number;
  failToolRequests?: number;
  pathname: string;
  requests: RecordedRequest[];
}): Promise<RunningServer> {
  let failInitializations = options.failInitializations ?? 0;
  let failToolRequests = options.failToolRequests ?? 0;
  const transports = new Set<NodeStreamableHTTPServerTransport>();
  const mcpServers = new Set<McpServer>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET') {
      options.requests.push({
        headers: request.headers,
        method: 'GET',
        pathname: url.pathname,
      });
      response.writeHead(405).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }

    const body = await readJsonBody(request);
    options.requests.push({
      body,
      headers: request.headers,
      method: 'POST',
      pathname: url.pathname,
    });
    if (requestMethod(body) === 'initialize' && failInitializations > 0) {
      failInitializations -= 1;
      response.writeHead(404).end('not found');
      return;
    }
    if (requestMethod(body)?.startsWith('tools/') && failToolRequests > 0) {
      failToolRequests -= 1;
      response.writeHead(404).end('not found');
      return;
    }

    // Stateless mode: `sessionIdGenerator` stays unset (exactOptionalPropertyTypes
    // forbids an explicit `undefined`).
    const transport = new NodeStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const mcpServer = createEchoServer();
    transports.add(transport);
    mcpServers.add(mcpServer);
    try {
      // The SDK's accessor-based `onclose`/`onerror` declarations are not
      // exactOptionalPropertyTypes-compatible with its own `Transport` interface.
      await mcpServer.connect(transport as Transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      }
    }
  });

  const running = await listen(server, options.pathname);
  cleanupTasks.push(async () => {
    await Promise.allSettled([
      ...Array.from(mcpServers, (mcpServer) => mcpServer.close()),
      ...Array.from(transports, (transport) => transport.close()),
    ]);
  });
  return running;
}

async function startSseServer(options: {
  createMcpServer?: () => McpServer;
  pathname: string;
  requests: RecordedRequest[];
}): Promise<RunningServer> {
  let transport: SSEServerTransport | undefined;
  let mcpServer: McpServer | undefined;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    options.requests.push({
      headers: request.headers,
      method: request.method ?? 'UNKNOWN',
      pathname: url.pathname,
    });

    if (request.method === 'GET' && url.pathname === options.pathname) {
      transport = new SSEServerTransport('/messages', response);
      mcpServer = options.createMcpServer?.() ?? createEchoServer();
      await mcpServer.connect(transport);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/messages' && transport) {
      const body = await readJsonBody(request);
      options.requests.at(-1)!.body = body;
      await transport.handlePostMessage(request, response, body);
      return;
    }
    response.writeHead(404).end();
  });

  const running = await listen(server, options.pathname);
  cleanupTasks.push(async () => {
    await Promise.allSettled([mcpServer?.close(), transport?.close()].filter(Boolean));
  });
  return running;
}

async function startStatefulStreamableServer(options: {
  deleteStatus?: number;
  pathname: string;
  requests: RecordedRequest[];
}): Promise<RunningServer> {
  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => 'explicit-http-test-session',
  });
  const mcpServer = createEchoServer();
  // See the stateless server above: SDK accessor declarations vs `Transport`.
  await mcpServer.connect(transport as Transport);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
    options.requests.push({
      body,
      headers: request.headers,
      method: request.method ?? 'UNKNOWN',
      pathname: url.pathname,
    });

    if (request.method === 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.method === 'DELETE' && options.deleteStatus) {
      response.writeHead(options.deleteStatus).end('termination failed');
      return;
    }
    await transport.handleRequest(request, response, body);
  });

  const running = await listen(server, options.pathname);
  cleanupTasks.push(async () => {
    await Promise.allSettled([mcpServer.close(), transport.close()]);
  });
  return running;
}

async function startExpiringStatefulServer(options: {
  connectionClosedToolCalls?: number;
  pathname: string;
  requests: RecordedRequest[];
}): Promise<ExpiringStatefulServer> {
  let connectionClosedToolCalls = options.connectionClosedToolCalls ?? 0;
  let expired = false;
  let onExpiredRequest: (() => void) | undefined;
  let sessionGeneration = 0;
  let validSession: string | undefined;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
    options.requests.push({
      body,
      headers: request.headers,
      method: request.method ?? 'UNKNOWN',
      pathname: url.pathname,
    });

    if (request.method === 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.method === 'DELETE') {
      if (request.headers['mcp-session-id'] !== validSession || expired) {
        response.writeHead(404).end('no valid session');
        return;
      }
      validSession = undefined;
      response.writeHead(200).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }

    const method = requestMethod(body);
    const requestId =
      body && typeof body === 'object' && 'id' in body ? (body.id as number | string) : undefined;
    if (method === 'initialize') {
      if (request.headers['mcp-session-id']) {
        response.writeHead(400).end('initialize must not carry a prior session');
        return;
      }
      sessionGeneration += 1;
      validSession = `explicit-http-session-${sessionGeneration}`;
      expired = false;
      response
        .writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': validSession,
        })
        .end(
          JSON.stringify({
            id: requestId,
            jsonrpc: '2.0',
            result: {
              capabilities: { tools: {} },
              protocolVersion: '2025-11-25',
              serverInfo: { name: 'expiring-session-server', version: '1.0.0' },
            },
          })
        );
      return;
    }

    if (request.headers['mcp-session-id'] !== validSession || expired) {
      onExpiredRequest?.();
      response.writeHead(404).end('no valid session');
      return;
    }
    if (method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }
    if (method === 'tools/list') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: requestId, jsonrpc: '2.0', result: { tools: [] } }));
      return;
    }
    if (method === 'tools/call') {
      if (connectionClosedToolCalls > 0) {
        connectionClosedToolCalls -= 1;
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { code: MCP_CONNECTION_CLOSED_PROTOCOL_CODE, message: 'Connection closed' },
            id: requestId,
            jsonrpc: '2.0',
          })
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: requestId,
          jsonrpc: '2.0',
          result: { content: [{ text: 'unexpected replay', type: 'text' }] },
        })
      );
      return;
    }
    response.writeHead(400).end('unexpected MCP request');
  });

  const running = await listen(server, options.pathname);
  return {
    ...running,
    expireSession: (callback) => {
      expired = true;
      onExpiredRequest = callback;
    },
  };
}

function trackClient(options: ExplicitHttpMcpClientOptions): ExplicitHttpMcpClient {
  const client = new ExplicitHttpMcpClient(options);
  cleanupTasks.push(() => client.close());
  return client;
}

// Every case here drives a REAL local HTTP/SSE server through real fetches —
// sub-second when idle, but the 5s vitest default flaked on loaded machines
// (the suite is env-sensitive by contract, per the *.integration.* suffix).
/**
 * Asserts the session DELETE was issued AFTER every protocol request, without
 * requiring it to be last overall.
 *
 * `connect()` leaves an SSE **GET** stream open and a reconnect GET can be
 * recorded after the DELETE under load, which is what made the positional
 * `requests.at(-1)` assertion fail intermittently (#1638, BST-1083). Filtering
 * GETs out keeps the part of the ordering that IS a contract — the DELETE
 * follows every POST — while dropping only the part that never was.
 */
function expectSessionDeletedLast(requests: readonly RecordedRequest[], pathname: string): void {
  expect(requests.filter((request) => request.method !== 'GET').at(-1)).toMatchObject({
    method: 'DELETE',
    pathname,
  });
}

describe('ExplicitHttpMcpClient integration', { timeout: 30_000 }, () => {
  it('exposes the negotiated legacy revision and server initialize metadata', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startStreamableServer({ pathname: '/mcp', requests });
    const client = trackClient({
      name: 'legacy-metadata-canary',
      protocol: 'legacy',
      transport: 'streamable-http',
      url: server.url,
    });
    expect(client.getProtocolEra()).toBeUndefined();
    expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
    expect(client.getServerVersion()).toBeUndefined();
    expect(client.getServerCapabilities()).toBeUndefined();
    await client.connect();
    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getServerVersion()).toEqual({
      name: 'explicit-http-test-server',
      version: '1.0.0',
    });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
    expect(requests.map((request) => requestMethod(request.body)).filter(Boolean)).toEqual([
      'initialize',
      'notifications/initialized',
    ]);
    await client.close();
    expect(client.getProtocolEra()).toBeUndefined();
    expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
    expect(client.getServerVersion()).toBeUndefined();
    expect(client.getServerCapabilities()).toBeUndefined();
  });
  it('auto-negotiates modern through the real Streamable HTTP discover exchange', async () => {
    const handler = createMcpHandler(() => createEchoServer(), { legacy: 'reject' });
    cleanupTasks.push(() => handler.close());
    const client = trackClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = await request
          .clone()
          .json()
          .catch(() => undefined);
        expect(body).toMatchObject({
          params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } },
        });
        return handler.fetch(request);
      },
      name: 'auto-modern-canary',
      protocol: 'auto',
      transport: 'streamable-http',
      url: new URL('http://mcp-modern.invalid/mcp'),
    });
    await client.connect();
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()).toEqual({
      name: 'explicit-http-test-server',
      version: '1.0.0',
    });
  });
  it('rejects unsupported core feature lists with a typed capability error', async () => {
    const handler = createMcpHandler(() => createEchoServer(), { legacy: 'reject' });
    cleanupTasks.push(() => handler.close());
    const client = trackClient({
      fetch: (input, init) => handler.fetch(new Request(input, init)),
      name: 'strict-capability-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: new URL('http://mcp-modern.invalid/mcp'),
    });

    await client.connect();
    await expect(client.listResources()).rejects.toMatchObject({
      code: SdkErrorCode.CapabilityNotSupported,
    });
  });
  it('preserves every core server feature through a real modern server', async () => {
    const handler = createMcpHandler(() => createCoreFeatureServer(), { legacy: 'reject' });
    cleanupTasks.push(() => handler.close());
    const client = trackClient({
      fetch: (input, init) => handler.fetch(new Request(input, init)),
      name: 'modern-core-features',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: new URL('http://mcp-modern.invalid/mcp'),
    });

    expect((await client.listResources()).resources).toMatchObject([
      { name: 'BST-1471', uri: 'linear://issue/BST-1471' },
    ]);
    expect((await client.listResourceTemplates()).resourceTemplates).toMatchObject([
      { name: 'issue', uriTemplate: 'linear://issue/{identifier}' },
    ]);
    expect(await client.readResource({ uri: 'linear://issue/BST-1471' })).toMatchObject({
      cacheScope: 'private',
      contents: [
        { text: '# BST-1471', uri: 'linear://issue/BST-1471' },
        { blob: 'AAEC', mimeType: 'application/octet-stream' },
      ],
      ttlMs: 1000,
    });
    expect((await client.listPrompts()).prompts).toMatchObject([{ name: 'summarize-issue' }]);
    expect(
      await client.getPrompt({
        arguments: { identifier: 'BST-1471', tone: 'formal' },
        name: 'summarize-issue',
      })
    ).toMatchObject({
      messages: [
        { content: { type: 'text' } },
        { content: { type: 'image' } },
        { content: { type: 'resource_link' } },
        { content: { type: 'resource' } },
      ],
    });
    await expect(
      client.complete({
        argument: { name: 'tone', value: 'f' },
        ref: { name: 'summarize-issue', type: 'ref/prompt' },
      })
    ).resolves.toMatchObject({ completion: { values: ['formal', 'friendly'] } });
    await expect(
      client.subscribeResource({ uri: 'linear://issue/BST-1471' })
    ).rejects.toMatchObject({ code: SdkErrorCode.MethodNotSupportedByProtocolVersion });
  });

  it('preserves every core server feature and legacy resource subscriptions over real SSE', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startSseServer({
      createMcpServer: createCoreFeatureServer,
      pathname: '/legacy-core',
      requests,
    });
    const client = trackClient({
      name: 'legacy-core-features',
      protocol: 'legacy',
      transport: 'sse',
      url: server.url,
    });

    expect((await client.listResources()).resources).toHaveLength(1);
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);
    expect(await client.readResource({ uri: 'linear://issue/BST-1471' })).toMatchObject({
      contents: [{ text: '# BST-1471' }, { blob: 'AAEC' }],
    });
    expect((await client.listPrompts()).prompts).toHaveLength(1);
    expect(
      await client.getPrompt({
        arguments: { identifier: 'BST-1471', tone: 'friendly' },
        name: 'summarize-issue',
      })
    ).toMatchObject({
      messages: [
        { content: { type: 'text' } },
        { content: { type: 'image' } },
        { content: { type: 'resource_link' } },
        { content: { type: 'resource' } },
      ],
    });
    await expect(
      client.complete({
        argument: { name: 'tone', value: 'f' },
        ref: { name: 'summarize-issue', type: 'ref/prompt' },
      })
    ).resolves.toMatchObject({ completion: { values: ['formal', 'friendly'] } });
    await client.subscribeResource({ uri: 'linear://issue/BST-1471' });
    await client.unsubscribeResource({ uri: 'linear://issue/BST-1471' });
    await expect(client.listen({ toolsListChanged: true })).rejects.toMatchObject({
      code: SdkErrorCode.MethodNotSupportedByProtocolVersion,
    });
    expect(requests.map((request) => requestMethod(request.body))).not.toContain(
      'subscriptions/listen'
    );
  });
  it('auto-negotiates legacy only after the modern probe returns legacy evidence', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startStreamableServer({ pathname: '/mcp', requests });
    const client = trackClient({
      name: 'auto-legacy-canary',
      protocol: 'auto',
      transport: 'streamable-http',
      url: server.url,
    });
    await client.connect();
    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(requests.map((request) => requestMethod(request.body)).filter(Boolean)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
    ]);
  });

  it.each([
    { code: SdkErrorCode.ClientHttpAuthentication, status: 401 },
    { code: SdkErrorCode.ClientHttpForbidden, status: 403 },
  ])('keeps auto-probe HTTP $status as an authentication outcome', async ({ code, status }) => {
    const requests: RecordedRequest[] = [];
    const server = createServer(async (request, response) => {
      const body = await readJsonBody(request);
      requests.push({
        body,
        headers: request.headers,
        method: request.method ?? 'UNKNOWN',
        pathname: new URL(request.url ?? '/', 'http://localhost').pathname,
      });
      response.writeHead(status).end();
    });
    const running = await listen(server, '/mcp');
    const client = trackClient({
      name: `auth-${status}-canary`,
      protocol: 'auto',
      transport: 'streamable-http',
      url: running.url,
    });

    await expect(client.connect()).rejects.toMatchObject({ code, status });
    expect(requests.map((request) => requestMethod(request.body))).toEqual(['server/discover']);
  });

  it('keeps pinned-modern rejection distinct and never initializes the legacy server', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startStreamableServer({ pathname: '/mcp', requests });
    const client = trackClient({
      name: 'pinned-modern-rejection-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: server.url,
    });

    await expect(client.connect()).rejects.toMatchObject({
      code: SdkErrorCode.EraNegotiationFailed,
    });
    expect(requests.map((request) => requestMethod(request.body)).filter(Boolean)).toEqual([
      'server/discover',
    ]);
  });

  it('keeps an unanswered HTTP auto probe as a request timeout, not legacy evidence', async () => {
    const requests: RecordedRequest[] = [];
    const server = createServer(async (request) => {
      const body = await readJsonBody(request);
      requests.push({
        body,
        headers: request.headers,
        method: request.method ?? 'UNKNOWN',
        pathname: new URL(request.url ?? '/', 'http://localhost').pathname,
      });
      await new Promise<void>(() => undefined);
    });
    const running = await listen(server, '/mcp');
    const client = trackClient({
      name: 'silent-auto-probe-canary',
      protocol: 'auto',
      transport: 'streamable-http',
      url: running.url,
    });

    await expect(client.connect({ timeout: 50 })).rejects.toMatchObject({
      code: SdkErrorCode.RequestTimeout,
    });
    expect(requests.map((request) => requestMethod(request.body))).toEqual(['server/discover']);
  });

  it('retains the HTTP status when an auto probe fails with a server error', async () => {
    const requests: RecordedRequest[] = [];
    const server = createServer(async (request, response) => {
      const body = await readJsonBody(request);
      requests.push({
        body,
        headers: request.headers,
        method: request.method ?? 'UNKNOWN',
        pathname: new URL(request.url ?? '/', 'http://localhost').pathname,
      });
      response.writeHead(503).end();
    });
    const running = await listen(server, '/mcp');
    const client = trackClient({
      name: 'server-error-auto-probe-canary',
      protocol: 'auto',
      transport: 'streamable-http',
      url: running.url,
    });

    const error = await client.connect().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SdkHttpError);
    expect(error).toMatchObject({ code: SdkErrorCode.EraNegotiationFailed, status: 503 });
    expect(requests.map((request) => requestMethod(request.body))).toEqual(['server/discover']);
    expect(client.getProtocolEra()).toBeUndefined();
    expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
  });

  it('uses Streamable HTTP at a misleading /sse path without transport inference', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startStreamableServer({ pathname: '/sse', requests });
    const extension = createDeferredTestExtension();
    const client = trackClient({
      extensionRegistry: extension.registry,
      headers: {
        Authorization: 'Bearer streamable-canary',
        'X-Brainstrike-Test': 'alpha, beta',
      },
      name: 'streamable-canary',
      transport: 'streamable-http',
      url: server.url,
    });
    extension.register();
    const listed = await client.listTools();
    const called = await client.callTool({ arguments: { value: 'hello' }, name: 'echo' });
    const failed = await client.callTool({ name: 'fail' });

    expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'fail']);
    expect(called).toMatchObject({
      content: [{ text: 'hello', type: 'text' }],
      structuredContent: { echoed: 'hello' },
    });
    expect(failed).toMatchObject({
      content: [{ text: 'intentional failure', type: 'text' }],
      isError: true,
    });
    expect(requests[0]).toMatchObject({
      body: {
        method: 'initialize',
        params: {
          capabilities: {
            extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS },
          },
        },
      },
      method: 'POST',
      pathname: '/sse',
    });
    expect(requests[0]?.headers['mcp-session-id']).toBeUndefined();
    expect(requests[0]?.headers['mcp-protocol-version']).toBeUndefined();
    expect(requests[0]?.headers['last-event-id']).toBeUndefined();
    expect(
      requests
        .filter((request) => request.method === 'POST')
        .every(
          (request) =>
            request.headers.authorization === 'Bearer streamable-canary' &&
            request.headers['x-brainstrike-test'] === 'alpha, beta'
        )
    ).toBe(true);
  });

  it('does not fall back to legacy SSE when Streamable HTTP initialization returns 404', async () => {
    const requests: RecordedRequest[] = [];
    const server = createServer(async (request, response) => {
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
      requests.push({
        body,
        headers: request.headers,
        method: request.method ?? 'UNKNOWN',
        pathname: new URL(request.url ?? '/', 'http://localhost').pathname,
      });
      response.writeHead(request.method === 'POST' ? 404 : 500).end();
    });
    const running = await listen(server, '/mcp');
    const client = trackClient({
      name: 'no-fallback-canary',
      transport: 'streamable-http',
      url: running.url,
    });

    const failure = client.connect();
    await expect(failure).rejects.toBeInstanceOf(SdkHttpError);
    await expect(failure).rejects.toMatchObject({ status: 404 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ body: { method: 'initialize' }, method: 'POST' });
  });

  it('uses legacy SSE explicitly even when its URL looks like a Streamable HTTP endpoint', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startSseServer({ pathname: '/mcp', requests });
    const client = trackClient({
      headers: { 'X-Brainstrike-Test': 'legacy-sse' },
      name: 'sse-canary',
      transport: 'sse',
      url: server.url,
    });

    const listed = await client.listTools();
    const called = await client.callTool({ arguments: { value: 'legacy' }, name: 'echo' });

    expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'fail']);
    expect(called).toMatchObject({ structuredContent: { echoed: 'legacy' } });
    expect(requests[0]).toMatchObject({ method: 'GET', pathname: '/mcp' });
    expect(requests[0]?.headers['x-brainstrike-test']).toBe('legacy-sse');
    expect(
      requests
        .filter((request) => request.method === 'POST')
        .every((request) => request.headers['x-brainstrike-test'] === 'legacy-sse')
    ).toBe(true);
  });

  it('retries a failed initial connection with a fresh transport and deduplicates lazy connects', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startStreamableServer({
      failInitializations: 1,
      pathname: '/mcp',
      requests,
    });
    const client = trackClient({
      name: 'connection-lifecycle-canary',
      transport: 'streamable-http',
      url: server.url,
    });

    await expect(client.connect()).rejects.toMatchObject({ status: 404 });
    const [first, second] = await Promise.all([client.listTools(), client.listTools()]);

    expect(first.tools).toHaveLength(2);
    expect(second.tools).toHaveLength(2);
    expect(requests.filter((request) => requestMethod(request.body) === 'initialize')).toHaveLength(
      2
    );
  });

  it('forwards cancellation and makes close terminal and idempotent', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startStreamableServer({ pathname: '/mcp', requests });
    const client = trackClient({
      name: 'close-canary',
      transport: 'streamable-http',
      url: server.url,
    });
    await client.connect();
    const controller = new AbortController();
    controller.abort();

    await expect(client.listTools({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await client.close();
    await client.close();
    await expect(client.listTools()).rejects.toThrow('Explicit HTTP MCP client is closed');
  });

  it('shares one close operation and promptly aborts a connection still initializing', async () => {
    let initializeSignal: AbortSignal | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const client = new ExplicitHttpMcpClient({
      fetch: async (_url, init) => {
        initializeSignal = init?.signal ?? undefined;
        markFetchStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          initializeSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('initialization aborted', 'AbortError')),
            { once: true }
          );
        });
      },
      name: 'hung-initialize-close-canary',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });

    const connecting = client.connect();
    void connecting.catch(() => undefined);
    await fetchStarted;
    const firstClose = client.close();
    const secondClose = client.close();

    expect(secondClose).toBe(firstClose);
    await expect(
      Promise.race([
        firstClose.then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 200)),
      ])
    ).resolves.toBe('closed');
    expect(initializeSignal?.aborted).toBe(true);
    await expect(connecting).rejects.toThrow();
  });

  it('terminates a stateful Streamable HTTP session before closing locally', async () => {
    const requests: RecordedRequest[] = [];
    const signals: AbortSignal[] = [];
    const trackedFetch: ExplicitHttpMcpFetch = async (url, init) => {
      if (init?.signal) {
        signals.push(init.signal);
      }
      return fetch(url, init);
    };
    const server = await startStatefulStreamableServer({ pathname: '/mcp', requests });
    const client = new ExplicitHttpMcpClient({
      fetch: trackedFetch,
      name: 'session-close-canary',
      transport: 'streamable-http',
      url: server.url,
    });

    await client.connect();
    await client.close();

    expectSessionDeletedLast(requests, '/mcp');
    expect(signals.some((signal) => signal.aborted)).toBe(true);
  });

  it('still closes locally and surfaces the error when session termination fails', async () => {
    const requests: RecordedRequest[] = [];
    const signals: AbortSignal[] = [];
    const trackedFetch: ExplicitHttpMcpFetch = async (url, init) => {
      if (init?.signal) {
        signals.push(init.signal);
      }
      return fetch(url, init);
    };
    const server = await startStatefulStreamableServer({
      deleteStatus: 500,
      pathname: '/mcp',
      requests,
    });
    const client = new ExplicitHttpMcpClient({
      fetch: trackedFetch,
      name: 'session-close-failure-canary',
      transport: 'streamable-http',
      url: server.url,
    });

    await client.connect();
    await expect(client.close()).rejects.toThrow(/Failed to terminate session/);

    expectSessionDeletedLast(requests, '/mcp');
    expect(signals.some((signal) => signal.aborted)).toBe(true);
    await expect(client.listTools()).rejects.toThrow('Explicit HTTP MCP client is closed');
  });

  it('bounds a hung session DELETE, aborts its fetch, and still closes locally', async () => {
    const requests: RecordedRequest[] = [];
    let deleteSignal: AbortSignal | undefined;
    const server = await startStatefulStreamableServer({ pathname: '/mcp', requests });
    const client = new ExplicitHttpMcpClient({
      fetch: async (url, init) => {
        if (init?.method === 'DELETE') {
          deleteSignal = init.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }
        return fetch(url, init);
      },
      name: 'hung-session-delete-canary',
      transport: 'streamable-http',
      url: server.url,
    });
    await client.connect();

    const firstClose = client.close();
    const secondClose = client.close();
    expect(secondClose).toBe(firstClose);
    const outcome = await Promise.race([
      firstClose.then(
        () => 'resolved' as const,
        (error: unknown) => error
      ),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1000)),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/session termination timed out/i);
    expect(deleteSignal?.aborted).toBe(true);
    await expect(client.listTools()).rejects.toThrow('Explicit HTTP MCP client is closed');
  });
  it.each([
    { lifecycle: 'client-owned', requestCount: 2, result: 'resolved', unexpectedCloses: 0 },
    { lifecycle: 'host-owned', requestCount: 1, result: 'rejected', unexpectedCloses: 1 },
  ] as const)(
    '$lifecycle handles an expired session without changing ownership',
    async (testCase) => {
      const requests: RecordedRequest[] = [];
      const server = await startExpiringStatefulServer({ pathname: '/mcp', requests });
      let unexpectedCloses = 0;
      const client = trackClient({
        lifecycle: testCase.lifecycle,
        name: `${testCase.lifecycle}-expired-session-canary`,
        onUnexpectedClose: () => {
          unexpectedCloses += 1;
        },
        transport: 'streamable-http',
        url: server.url,
      });
      await client.connect();
      server.expireSession();
      const listing = client.listTools();
      await (testCase.result === 'resolved'
        ? expect(listing).resolves.toMatchObject({ tools: [] })
        : expect(listing).rejects.toMatchObject({ status: 404 }));
      expect(requestCount(requests, 'initialize')).toBe(testCase.requestCount);
      expect(requestCount(requests, 'tools/list')).toBe(testCase.requestCount);
      expect(unexpectedCloses).toBe(testCase.unexpectedCloses);

      if (testCase.lifecycle === 'client-owned') {
        const initializeRequests = requests.filter(
          (request) => requestMethod(request.body) === 'initialize'
        );
        expect(initializeRequests[0]?.headers['mcp-session-id']).toBeUndefined();
        expect(initializeRequests[1]?.headers['mcp-session-id']).toBeUndefined();
        return;
      }

      await expect(client.listTools()).resolves.toMatchObject({ tools: [] });
      expect(requestCount(requests, 'initialize')).toBe(2);
      expect(requestCount(requests, 'tools/list')).toBe(2);
      await expect(client.close()).resolves.toBeUndefined();
      expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    }
  );
  it('isolates a throwing host-owned invalidation observer from the original failure', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startExpiringStatefulServer({ pathname: '/mcp', requests });
    const client = trackClient({
      lifecycle: 'host-owned',
      name: 'throwing-invalidation-observer-canary',
      onUnexpectedClose: () => {
        throw new Error('observer failed');
      },
      transport: 'streamable-http',
      url: server.url,
    });
    await client.connect();
    server.expireSession();

    await expect(client.listTools()).rejects.toMatchObject({ status: 404 });
  });
  it('preserves an in-flight session failure when terminal close wins the race', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startExpiringStatefulServer({ pathname: '/mcp', requests });
    const client = new ExplicitHttpMcpClient({
      name: 'close-race-session-canary',
      transport: 'streamable-http',
      url: server.url,
    });
    await client.connect();
    let closeResult: Promise<void> | undefined;
    server.expireSession(() => {
      closeResult = client.close();
    });

    await expect(client.listTools()).rejects.toMatchObject({ status: 404 });
    await expect(closeResult).rejects.toMatchObject({ status: 404 });
  });
  it('does not reinterpret a stateless operation 404 as an expired session', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startStreamableServer({
      failToolRequests: 2,
      pathname: '/mcp',
      requests,
    });
    const client = trackClient({
      name: 'stateless-operation-404-canary',
      transport: 'streamable-http',
      url: server.url,
    });
    await client.connect();

    await expect(client.listTools()).rejects.toMatchObject({ status: 404 });
    expect(requestCount(requests, 'initialize')).toBe(1);
    expect(requestCount(requests, 'tools/list')).toBe(1);
  });

  it('surfaces ConnectionClosed without replaying a potentially mutating tool call', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startExpiringStatefulServer({
      connectionClosedToolCalls: 1,
      pathname: '/mcp',
      requests,
    });
    const client = trackClient({
      name: 'connection-closed-no-replay-canary',
      transport: 'streamable-http',
      url: server.url,
    });
    await client.connect();

    await expect(client.callTool({ name: 'mutating-tool' })).rejects.toMatchObject({
      code: MCP_CONNECTION_CLOSED_PROTOCOL_CODE,
      message: 'Connection closed',
    });
    expect(requestCount(requests, 'initialize')).toBe(1);
    expect(requestCount(requests, 'tools/call')).toBe(1);
  });

  it('does not reinitialize a reconnectable failure after the caller is aborted', async () => {
    const requests: RecordedRequest[] = [];
    const server = await startExpiringStatefulServer({ pathname: '/mcp', requests });
    const client = new ExplicitHttpMcpClient({
      name: 'aborted-session-reinitialize-canary',
      transport: 'streamable-http',
      url: server.url,
    });
    await client.connect();
    const controller = new AbortController();
    server.expireSession(() => controller.abort());

    await expect(client.listTools({ signal: controller.signal })).rejects.toThrow();
    expect(requests.filter((request) => requestMethod(request.body) === 'initialize')).toHaveLength(
      1
    );
    await expect(client.close()).rejects.toMatchObject({ status: 404 });
  });
});
