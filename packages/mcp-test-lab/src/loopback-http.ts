import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  type NodeIncomingMessageLike,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

export interface McpLabLoopbackHandle {
  close(): Promise<void>;
  readonly handler: McpHttpHandler;
  readonly url: URL;
}

export type McpLabLoopbackHandlerFactory = (origin: URL) => McpHttpHandler;

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('MCP lab listener has no TCP address')));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function toNodeRequest(request: IncomingMessage): NodeIncomingMessageLike {
  return {
    [Symbol.asyncIterator]() {
      return request[Symbol.asyncIterator]();
    },
    headers: request.headers,
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: request.url }),
  };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function handlerFailureResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: 'mcp_lab_handler_error', message }, { status: 500 });
}

export async function createMcpLabLoopback(
  handlerOrFactory: McpHttpHandler | McpLabLoopbackHandlerFactory
): Promise<McpLabLoopbackHandle> {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let nodeHandler: ReturnType<typeof toNodeHandler> | undefined;
  const server = createServer((request, response) => {
    if (!(validateHost(request, response) && validateOrigin(request, response))) {
      return;
    }
    if (!nodeHandler) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: 'mcp_lab_handler_error',
          message: 'MCP lab listener accepted a request before its handler was installed',
        })
      );
      return;
    }
    void nodeHandler(toNodeRequest(request), response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'mcp_lab_handler_error', message }));
    });
  });
  const port = await listenLoopback(server);
  const origin = new URL(`http://127.0.0.1:${port}/`);
  let handler: McpHttpHandler;
  try {
    handler = typeof handlerOrFactory === 'function' ? handlerOrFactory(origin) : handlerOrFactory;
    nodeHandler = toNodeHandler({
      ...handler,
      async fetch(request, options) {
        try {
          return await handler.fetch(request, options);
        } catch (error) {
          return handlerFailureResponse(error);
        }
      },
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return Object.freeze({
    close: () => closeServer(server),
    handler,
    url: new URL('/mcp', origin),
  });
}
