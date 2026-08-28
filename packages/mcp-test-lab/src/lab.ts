import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  type NodeIncomingMessageLike,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpLabScenario, type McpLabScenario } from './scenario';

export interface McpLabSession {
  close: () => Promise<void>;
  readonly closed: boolean;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  scenario: McpLabScenario;
}

export interface McpLabCleanupReport {
  readonly httpListenersClosed: number;
  readonly untriggeredFaultIds: readonly string[];
}

export interface McpLabLoopbackSession {
  close: () => Promise<McpLabCleanupReport>;
  readonly closed: boolean;
  endpoint: {
    readonly kind: 'loopback-http';
    readonly url: URL;
  };
  scenario: McpLabScenario;
}

function createModernReferenceServer(): McpServer {
  const server = new McpServer({
    name: 'brainstrike-sdk-v2-reference',
    version: '2.0.0',
  });
  const echoSchema = z.object({ text: z.string() });
  server.registerTool(
    'echo',
    {
      description: 'Echo a string through the official MCP TypeScript SDK v2 server.',
      inputSchema: echoSchema,
      outputSchema: echoSchema,
    },
    async ({ text }) => ({
      content: [{ text, type: 'text' }],
      structuredContent: { text },
    })
  );
  return server;
}

export function createMcpLabScenario(id: string): McpLabSession {
  const scenario = getMcpLabScenario(id);
  if (scenario.id !== 'modern-reference') {
    throw new Error(`MCP lab scenario is not implemented: ${scenario.id}`);
  }

  const handler = createMcpHandler(createModernReferenceServer, { legacy: 'reject' });
  let closed = false;

  return {
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await handler.close();
    },
    get closed() {
      return closed;
    },
    async fetch(input, init) {
      if (closed) {
        throw new Error(`MCP lab scenario is closed: ${scenario.id}`);
      }
      return handler.fetch(new Request(input, init));
    },
    scenario,
  };
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('MCP lab HTTP listener did not expose a TCP address'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function toMcpNodeRequest(request: IncomingMessage): NodeIncomingMessageLike {
  return {
    [Symbol.asyncIterator]() {
      return request[Symbol.asyncIterator]();
    },
    headers: request.headers,
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: request.url }),
  };
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startMcpLabScenario(id: string): Promise<McpLabLoopbackSession> {
  const scenario = getMcpLabScenario(id);
  if (scenario.id !== 'modern-reference') {
    throw new Error(`MCP lab loopback scenario is not implemented: ${scenario.id}`);
  }

  const handler = createMcpHandler(createModernReferenceServer, { legacy: 'reject' });
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer((request, response) => {
    if (!validateHost(request, response)) {
      return;
    }
    if (!validateOrigin(request, response)) {
      return;
    }
    const mcpRequest = toMcpNodeRequest(request);
    void nodeHandler(mcpRequest, response).catch(() => {
      response.destroy();
    });
  });
  const port = await listenOnLoopback(server);
  let closePromise: Promise<McpLabCleanupReport> | undefined;

  return {
    close() {
      if (closePromise) {
        return closePromise;
      }
      closePromise = (async () => {
        const results = await Promise.allSettled([closeHttpServer(server), handler.close()]);
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, 'MCP lab loopback cleanup failed');
        }
        return { httpListenersClosed: 1, untriggeredFaultIds: [] };
      })();
      return closePromise;
    },
    get closed() {
      return closePromise !== undefined;
    },
    endpoint: {
      kind: 'loopback-http',
      url: new URL(`http://127.0.0.1:${port}/mcp`),
    },
    scenario,
  };
}
