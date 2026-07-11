import { createServer, type IncomingMessage, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
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
      inputSchema: { text: z.string() },
      outputSchema: { echo: z.string() },
    },
    async ({ text }, extra) => {
      if (extra._meta?.progressToken !== undefined) {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            message: 'echoing',
            progress: 1,
            progressToken: extra._meta.progressToken,
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

async function startStreamableHttpServer(pathname = '/sse'): Promise<RunningMcpServer> {
  const requests: ObservedRequest[] = [];
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

    if (request.method !== 'POST' || url.pathname !== pathname) {
      requests.push(observed);
      response.writeHead(404).end();
      return;
    }

    observed.body = await readJsonBody(request);
    requests.push(observed);

    const mcp = createFixtureMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);
    try {
      await transport.handleRequest(request, response, observed.body);
    } finally {
      await transport.close();
      await mcp.close();
    }
  });
  const running = await listen(server);
  return {
    close: running.close,
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

    await expect(client.listTools()).resolves.toMatchObject({
      'remote.echo': {
        description: 'Echoes text',
        inputSchema: expect.any(Object),
      },
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
        response.writeHead(404).end();
        return;
      }
      response.writeHead(500).end();
    });
    const running = await listen(rawServer);
    cleanup.push(running.close);
    const client = createHttpClient({
      name: 'remote',
      transport: 'streamable-http',
      url: `${running.origin}/sse`,
    });
    cleanup.push(async () => client.dispose());

    await expect(client.listTools()).rejects.toThrow(/Streamable HTTP error/u);
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
  });
});
