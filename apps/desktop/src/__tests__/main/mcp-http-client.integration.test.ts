import { createServer, type IncomingMessage, type Server } from 'node:http';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { SdkHttpError } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { createHttpClient } from '../../mcp/http-client';

interface ObservedRequest {
  authorization?: string;
  body?: unknown;
  method: string;
  pathname: string;
}

interface RunningMcpServer {
  close: () => Promise<void>;
  requests: ObservedRequest[];
  url: string;
}

const cleanup: Array<() => Promise<void>> = [];

async function closeAll(disposers: ReadonlyArray<() => Promise<void>>): Promise<void> {
  let firstError: unknown;
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

function createFixtureMcpServer(): McpServer {
  const server = new McpServer({ name: 'desktop-http-fixture', version: '1.0.0' });

  server.registerTool(
    'echo',
    {
      description: 'Echoes text',
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ echo: z.string() }),
    },
    async ({ text }, ctx) => {
      if (ctx.mcpReq._meta?.progressToken !== undefined) {
        await ctx.mcpReq.notify({
          method: 'notifications/progress',
          params: {
            message: 'echoing',
            progress: 1,
            progressToken: ctx.mcpReq._meta.progressToken,
            total: 1,
          },
        });
      }

      return {
        content: [{ text, type: 'text' }],
        structuredContent: { echo: text },
      };
    }
  );

  server.registerTool('fail', {}, async () => ({
    content: [{ text: 'expected failure', type: 'text' }],
    isError: true,
  }));

  server.registerTool('slow', {}, async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { content: [{ text: 'too late', type: 'text' }] };
  });

  return server;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : undefined;
}

async function listen(server: Server): Promise<{ close: () => Promise<void>; origin: string }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('Expected an assigned TCP port');
  }

  return {
    async close(): Promise<void> {
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
    },
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function startStreamableHttpServer(
  pathname = '/sse',
  sessionIdGenerator?: () => string
): Promise<RunningMcpServer> {
  const requests: ObservedRequest[] = [];
  const statefulMcp = sessionIdGenerator ? createFixtureMcpServer() : undefined;
  const statefulTransport = sessionIdGenerator
    ? new NodeStreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator,
      })
    : undefined;
  if (statefulMcp && statefulTransport) {
    await statefulMcp.connect(statefulTransport);
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const observed: ObservedRequest = {
      method: request.method ?? 'GET',
      pathname: url.pathname,
    };
    const authorization = request.headers.authorization;
    if (authorization) {
      observed.authorization = authorization;
    }

    if (request.method === 'GET') {
      requests.push(observed);
      response.writeHead(405).end();
      return;
    }

    if (
      url.pathname !== pathname ||
      (!(statefulMcp && statefulTransport) && request.method !== 'POST')
    ) {
      requests.push(observed);
      response.writeHead(404).end();
      return;
    }

    observed.body = request.method === 'POST' ? await readJsonBody(request) : undefined;
    requests.push(observed);

    if (statefulMcp && statefulTransport) {
      await statefulTransport.handleRequest(request, response, observed.body);
      return;
    }
    const mcp = createFixtureMcpServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);
    try {
      await transport.handleRequest(request, response, observed.body);
    } finally {
      await closeAll([() => transport.close(), () => mcp.close()]);
    }
  });
  const running = await listen(server);
  return {
    close: async () => {
      await closeAll([
        ...(statefulTransport ? [() => statefulTransport.close()] : []),
        ...(statefulMcp ? [() => statefulMcp.close()] : []),
        running.close,
      ]);
    },
    requests,
    url: `${running.origin}${pathname}`,
  };
}

async function startLegacySseServer(pathname = '/legacy'): Promise<RunningMcpServer> {
  const requests: ObservedRequest[] = [];
  const sessions = new Map<string, { mcp: McpServer; transport: SSEServerTransport }>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const observed: ObservedRequest = {
      method: request.method ?? 'GET',
      pathname: url.pathname,
    };
    const authorization = request.headers.authorization;
    if (authorization) {
      observed.authorization = authorization;
    }

    if (request.method === 'GET' && url.pathname === pathname) {
      requests.push(observed);
      const transport = new SSEServerTransport('/messages', response);
      const mcp = createFixtureMcpServer();
      sessions.set(transport.sessionId, { mcp, transport });
      transport.onclose = () => {
        sessions.delete(transport.sessionId);
      };
      await mcp.connect(transport);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/messages') {
      observed.body = await readJsonBody(request);
      requests.push(observed);
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        response.writeHead(404).end();
        return;
      }
      await session.transport.handlePostMessage(request, response, observed.body);
      return;
    }

    requests.push(observed);
    response.writeHead(404).end();
  });
  const running = await listen(server);
  return {
    async close(): Promise<void> {
      await Promise.allSettled(
        Array.from(sessions.values(), async ({ mcp, transport }) => {
          await transport.close();
          await mcp.close();
        })
      );
      await running.close();
    },
    requests,
    url: `${running.origin}${pathname}`,
  };
}

describe('desktop explicit HTTP MCP client', () => {
  test('desktop host closes its real Streamable HTTP session after settled work', async () => {
    const server = await startStreamableHttpServer('/mcp', () => 'desktop-host-lifecycle-session');
    cleanup.push(server.close);
    const configuredServerId = parseConfiguredMcpServerId('linear.lifecycle');
    const runtime = createDesktopMcpHostRuntime();
    let runtimeCloseAttempted = false;
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            name: configuredServerId,
            protocol: 'auto',
            startup: 'automatic',
            transport: 'streamable-http',
            url: server.url,
          },
        ],
      });
      await runtime.host.invoke({ configuredServerId, type: 'tools/list' });

      runtimeCloseAttempted = true;
      await expect(runtime.host.close()).resolves.toMatchObject({
        childProcessesClosed: 0,
        clientsClosed: 1,
        failures: [],
        requestsSettled: 1,
      });
      expect(server.requests.filter(({ method }) => method !== 'GET').at(-1)).toMatchObject({
        method: 'DELETE',
        pathname: '/mcp',
      });
    } finally {
      if (!runtimeCloseAttempted) {
        await runtime.host.close();
      }
    }
  }, 30_000);

  test('uses Streamable HTTP at a URL ending in /sse without probing legacy SSE', async () => {
    const server = await startStreamableHttpServer();
    cleanup.push(server.close);
    const client = createHttpClient({
      headers: { Authorization: 'Bearer streamable-token' },
      name: 'remote',
      transport: 'streamable-http',
      url: server.url,
    });
    cleanup.push(async () => client.dispose());

    expect(client.getStatus()).toEqual({
      configuredProtocol: 'legacy',
      name: 'remote',
      state: 'disconnected',
      transport: 'streamable-http',
    });

    await expect(client.listTools()).resolves.toMatchObject({
      'remote.echo': {
        description: 'Echoes text',
        inputSchema: expect.any(Object),
      },
    });
    expect(client.getStatus()).toMatchObject({
      negotiated: {
        advertisedCapabilityIds: ['tools'],
        era: 'legacy',
        revision: '2025-11-25',
        serverIdentity: { name: 'desktop-http-fixture', version: '1.0.0' },
      },
      state: 'connected',
    });

    const progress: Array<{ meta?: { id?: string }; payload: unknown }> = [];
    const result = await client.callTool(
      'remote.echo',
      { text: 'hello' },
      { onProgress: (payload, meta) => progress.push({ meta, payload }) }
    );

    expect(result).toMatchObject({
      content: [{ text: 'hello', type: 'text' }],
      structuredContent: { echo: 'hello' },
    });
    expect(progress).toEqual([
      {
        meta: undefined,
        payload: expect.objectContaining({ message: 'echoing', progress: 1, total: 1 }),
      },
    ]);
    expect(server.requests[0]).toMatchObject({
      authorization: 'Bearer streamable-token',
      body: expect.objectContaining({ method: 'initialize' }),
      method: 'POST',
      pathname: '/sse',
    });
    expect(server.requests.filter(({ method }) => method === 'GET')).toEqual([
      expect.objectContaining({ pathname: '/sse' }),
    ]);
  });

  test('does not fall back to legacy SSE when Streamable HTTP initialization fails', async () => {
    const requests: ObservedRequest[] = [];
    const rawServer = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: request.method ?? 'GET', pathname: url.pathname });
      if (request.method === 'POST') {
        await readJsonBody(request);
        response.writeHead(404).end(request.headers['x-api-key']);
        return;
      }
      response.writeHead(500).end();
    });
    const running = await listen(rawServer);
    cleanup.push(running.close);
    const client = createHttpClient({
      headers: { 'X-API-Key': 'reflected-secret' },
      name: 'remote',
      transport: 'streamable-http',
      url: `${running.origin}/sse`,
    });
    cleanup.push(async () => client.dispose());

    const failure = client.listTools();
    await expect(failure).rejects.toBeInstanceOf(SdkHttpError);
    await expect(failure).rejects.toMatchObject({ status: 404 });
    expect(client.getStatus()).toMatchObject({ error: 'MCP connection failed (HTTP 404)' });
    expect(requests).toEqual([{ method: 'POST', pathname: '/sse' }]);
  });

  test('uses only the legacy SSE transport when selected explicitly', async () => {
    const server = await startLegacySseServer('/mcp');
    cleanup.push(server.close);
    const client = createHttpClient({
      headers: { Authorization: 'Bearer legacy-token' },
      name: 'legacy',
      transport: 'sse',
      url: server.url,
    });
    cleanup.push(async () => client.dispose());

    await expect(client.listTools()).resolves.toHaveProperty('legacy.echo');
    await expect(client.callTool('legacy.fail')).resolves.toMatchObject({
      content: [{ text: 'expected failure', type: 'text' }],
      isError: true,
    });

    expect(server.requests[0]).toEqual({
      authorization: 'Bearer legacy-token',
      method: 'GET',
      pathname: '/mcp',
    });
    expect(
      server.requests.some(({ method, pathname }) => method === 'POST' && pathname === '/mcp')
    ).toBe(false);
    expect(server.requests.filter(({ method }) => method === 'POST')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorization: 'Bearer legacy-token',
          pathname: '/messages',
        }),
      ])
    );
  });

  test('forwards AbortSignal cancellation to an in-flight tool call', async () => {
    const server = await startStreamableHttpServer('/mcp');
    cleanup.push(server.close);
    const client = createHttpClient({
      name: 'remote',
      transport: 'streamable-http',
      url: server.url,
    });
    cleanup.push(async () => client.dispose());
    const controller = new AbortController();

    const result = client.callTool('remote.slow', undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancelled by test')), 10);

    await expect(result).rejects.toThrow(/cancel/u);
  });

  test('makes disposal terminal and clears discovered tool support', async () => {
    const server = await startStreamableHttpServer('/mcp');
    cleanup.push(server.close);
    const client = createHttpClient({
      name: 'remote',
      transport: 'streamable-http',
      url: server.url,
    });

    await client.listTools();
    expect(client.supportsTool('remote.echo')).toBe(true);

    await client.dispose();

    expect(client.supportsTool('remote.echo')).toBe(false);
    await expect(client.listTools()).rejects.toThrow('Explicit HTTP MCP client is closed');
    expect(client.getStatus()).toMatchObject({ state: 'disconnected' });
  });
});
