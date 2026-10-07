/** Explicit Agent test fixture for cross-package Desktop host verification. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

export interface ObservedMcpHostRequest {
  readonly authorization?: string;
  readonly body?: unknown;
  readonly method: string;
  readonly pathname: string;
}

export interface RunningMcpHostServer {
  close(): Promise<void>;
  readonly requests: ObservedMcpHostRequest[];
  /** Fresh real server session at the same fixture destination after client teardown. */
  resetSession(): Promise<void>;
  readonly url: string;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : undefined;
}

async function listen(server: Server): Promise<{ close(): Promise<void>; origin: string }> {
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

async function closeAll(disposers: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'MCP host lifecycle fixture failed to close');
  }
}

function respondWithFixtureFailure(response: ServerResponse, error: unknown): void {
  if (!response.headersSent) {
    response.writeHead(error instanceof SyntaxError ? 400 : 500).end('MCP fixture request failed');
    return;
  }
  response.destroy(error instanceof Error ? error : undefined);
}

export async function startStatefulMcpHostServer(options?: {
  readonly pathname?: string;
}): Promise<RunningMcpHostServer> {
  const requests: ObservedMcpHostRequest[] = [];
  const pathname = options?.pathname ?? '/mcp';
  const openSession = async () => {
    const mcp = new McpServer({ name: 'desktop-host-lifecycle', version: '1.0.0' });
    mcp.registerTool('host_lifecycle_probe', {}, async () => ({
      content: [{ text: 'ok', type: 'text' }],
    }));
    const transport = new NodeStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => 'desktop-surviving-host-session',
    });
    await mcp.connect(transport);
    return { mcp, transport };
  };
  let session = await openSession();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
      requests.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        ...(body === undefined ? {} : { body }),
        method: request.method ?? 'UNKNOWN',
        pathname: url.pathname,
      });
      if (url.pathname !== pathname) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(405).end();
        return;
      }
      await session.transport.handleRequest(request, response, body);
    } catch (error) {
      respondWithFixtureFailure(response, error);
    }
  });
  const running = await listen(server);
  return {
    close: async () =>
      await closeAll([() => session.mcp.close(), () => session.transport.close(), running.close]),
    requests,
    resetSession: async () => {
      await closeAll([() => session.mcp.close(), () => session.transport.close()]);
      session = await openSession();
    },
    url: `${running.origin}${pathname}`,
  };
}
