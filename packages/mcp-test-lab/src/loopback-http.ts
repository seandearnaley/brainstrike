import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  type NodeIncomingMessageLike,
  toWebRequest,
} from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { McpLabCorrelationError, McpLabDroppedResponseError } from './fault-runtime.js';
import type { McpLabHttpFaultExecutor, McpLabHttpFaultScopes } from './http-fault-handler.js';

export interface McpLabLoopbackHandle {
  close(): Promise<void>;
  readonly handler: McpHttpHandler;
  readonly url: URL;
}

export type McpLabLoopbackHandlerFactory = (origin: URL) => McpHttpHandler;

export interface McpLabLoopbackOptions {
  readonly faultExecutor?: McpLabHttpFaultExecutor;
  readonly faultScopes?: McpLabHttpFaultScopes;
}

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

async function pipeNodeResponseBody(
  response: ServerResponse,
  body: ReadableStream<Uint8Array>
): Promise<void> {
  const reader = body.getReader();
  const disconnect = new AbortController();
  const onClose = () => {
    disconnect.abort();
    void reader.cancel().catch(() => undefined);
  };
  response.once('close', onClose);
  try {
    while (!disconnect.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (!response.write(chunk.value)) {
        await once(response, 'drain', { signal: disconnect.signal });
      }
    }
    if (!disconnect.signal.aborted) {
      response.end();
    }
  } catch (error) {
    if (disconnect.signal.aborted || response.destroyed) {
      return;
    }
    response.destroy(error instanceof Error ? error : undefined);
    throw error;
  } finally {
    response.off('close', onClose);
    reader.releaseLock();
  }
}

async function writeNodeResponse(
  response: ServerResponse,
  value: Response,
  requestMethod: string | undefined
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, headerValue] of value.headers) {
    if (name !== 'set-cookie') {
      headers[name] = headerValue;
    }
  }
  const cookies = value.headers.getSetCookie();
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies;
  }
  response.writeHead(value.status, headers);
  if (!value.body) {
    response.end();
    return;
  }
  if (requestMethod === 'HEAD' || value.status === 204 || value.status === 304) {
    await value.body.cancel();
    response.end();
    return;
  }
  await pipeNodeResponseBody(response, value.body);
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

async function rethrowAfterStartupCleanup(
  startError: unknown,
  server: Server,
  faultExecutor: McpLabHttpFaultExecutor | undefined
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    await closeServer(server);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await faultExecutor?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [startError, ...cleanupErrors],
      'MCP lab loopback startup cleanup failed'
    );
  }
  throw startError;
}

function handlerFailureResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: 'mcp_lab_handler_error', message }, { status: 500 });
}

function asNodeIncomingMessage(request: IncomingMessage): NodeIncomingMessageLike {
  return {
    [Symbol.asyncIterator]() {
      return request[Symbol.asyncIterator]();
    },
    headers: request.headers,
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: request.url }),
  };
}

export async function createMcpLabLoopback(
  handlerOrFactory: McpHttpHandler | McpLabLoopbackHandlerFactory,
  options: McpLabLoopbackOptions = {}
): Promise<McpLabLoopbackHandle> {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let activeHandler: McpHttpHandler | undefined;
  let advertisedOrigin: URL | undefined;
  const server = createServer((request, response) => {
    if (!(validateHost(request, response) && validateOrigin(request, response))) {
      return;
    }
    const handler = activeHandler;
    if (!handler) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: 'mcp_lab_handler_error',
          message: 'MCP lab listener accepted a request before its handler was installed',
        })
      );
      return;
    }
    const abort = new AbortController();
    const abortRequest = () => abort.abort();
    const abortIncompleteResponse = () => {
      if (!response.writableFinished) {
        abort.abort();
      }
    };
    request.once('aborted', abortRequest);
    response.once('close', abortIncompleteResponse);
    if (request.aborted || response.destroyed) {
      abort.abort();
    }
    const runDispatch = async (): Promise<void> => {
      try {
        const webRequest = await toWebRequest(asNodeIncomingMessage(request), undefined, {
          signal: abort.signal,
        });
        const executor = options.faultExecutor;
        const scopes = options.faultScopes;
        const hasAdvertisedAuthority =
          advertisedOrigin !== undefined &&
          new URL(webRequest.url).origin === advertisedOrigin.origin;
        let webResponse: Response;
        if (executor && scopes) {
          if (hasAdvertisedAuthority) {
            const prepared = await executor.prepare(webRequest, scopes);
            webResponse = prepared
              ? await executor.fetchPrepared(prepared, webRequest, handler, undefined, scopes)
              : await handler.fetch(webRequest);
          } else {
            webResponse = Response.json({ error: 'mcp_lab_invalid_authority' }, { status: 400 });
          }
        } else {
          webResponse = await handler.fetch(webRequest);
        }
        await writeNodeResponse(response, webResponse, webRequest.method);
      } finally {
        request.off('aborted', abortRequest);
        response.off('close', abortIncompleteResponse);
      }
    };
    void runDispatch().catch((error: unknown) => {
      if (error instanceof McpLabDroppedResponseError) {
        response.destroy(error);
        return;
      }
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const failure =
        error instanceof McpLabCorrelationError
          ? Response.json({ error: 'mcp_lab_invalid_correlation_id' }, { status: 400 })
          : handlerFailureResponse(error);
      void writeNodeResponse(response, failure, request.method).catch((writeError: unknown) => {
        response.destroy(writeError instanceof Error ? writeError : undefined);
      });
    });
  });
  const port = await listenLoopback(server).catch((error: unknown) =>
    rethrowAfterStartupCleanup(error, server, options.faultExecutor)
  );
  const origin = new URL(`http://127.0.0.1:${port}/`);
  advertisedOrigin = origin;
  const handler = await (async (): Promise<McpHttpHandler> => {
    try {
      return typeof handlerOrFactory === 'function' ? handlerOrFactory(origin) : handlerOrFactory;
    } catch (error) {
      return rethrowAfterStartupCleanup(error, server, options.faultExecutor);
    }
  })();
  activeHandler = handler;
  return Object.freeze({
    async close() {
      await closeServer(server);
      await options.faultExecutor?.close();
    },
    handler,
    url: new URL('/mcp', origin),
  });
}
