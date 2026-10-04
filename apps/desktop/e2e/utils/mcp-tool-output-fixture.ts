import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';

interface SdkHandler {
  close(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

interface SdkServer {
  registerTool(
    name: string,
    config: { annotations: { readOnlyHint: true }; description: string },
    execute: () => Promise<{ content: Array<{ text: string; type: 'text' }> }>
  ): void;
}

// Resolve the lab's pinned SDK public exports without making the lab or server
// SDK an application dependency. This is a test-only serving surface, like the
// SDK-backed lab loopback fixture; all protocol handling belongs to the SDK.
const requireLab = createRequire(
  new URL('../../../../packages/mcp-test-lab/package.json', import.meta.url)
);

export interface ToolOutputFixtureSnapshot {
  readonly activeRequests: number;
  readonly completedRequests: number;
  readonly handlersClosed: number;
  readonly httpListenersClosed: number;
  readonly listening: boolean;
  readonly openSockets: number;
  readonly toolCalls: number;
}

export interface ToolOutputFixture {
  close(): Promise<ToolOutputFixtureSnapshot & { readonly clean: true }>;
  readonly config: string;
  readonly serverName: string;
  snapshot(): ToolOutputFixtureSnapshot;
  readonly toolName: string;
  readonly url: string;
}

/** Serve the exact supplied corpus, without putting it in model tool arguments. */
export async function startToolOutputFixture(text: string): Promise<ToolOutputFixture> {
  const createMcpHandler = requireLab('@modelcontextprotocol/server').createMcpHandler as (
    factory: () => SdkServer,
    options: { legacy: 'stateless' }
  ) => SdkHandler;
  const McpServer = requireLab('@modelcontextprotocol/server').McpServer as new (identity: {
    name: string;
    version: string;
  }) => SdkServer;
  const node: {
    localhostHostValidation(): (request: IncomingMessage, response: ServerResponse) => boolean;
    localhostOriginValidation(): (request: IncomingMessage, response: ServerResponse) => boolean;
    toNodeHandler(
      handler: SdkHandler,
      options: { onerror: (error: Error) => void }
    ): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  } = requireLab('@modelcontextprotocol/node');
  const serverName = 'm2-output';
  const toolName = 'read_corpus';
  const failures: unknown[] = [];
  let toolCalls = 0;
  let completedRequests = 0;
  let handlersClosed = 0;
  let httpListenersClosed = 0;
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: serverName, version: '1.0.0' });
      mcp.registerTool(
        toolName,
        {
          annotations: { readOnlyHint: true },
          description: 'Read the complete qualification corpus supplied by the test owner.',
        },
        async () => {
          toolCalls += 1;
          return { content: [{ text, type: 'text' }] };
        }
      );
      return mcp;
    },
    { legacy: 'stateless' }
  );
  const dispatch = node.toNodeHandler(handler, { onerror: (error) => failures.push(error) });
  const validateHost = node.localhostHostValidation();
  const validateOrigin = node.localhostOriginValidation();
  const requests = new Set<Promise<void>>();
  const sockets = new Map<Socket, Promise<void>>();
  const server = createServer((request, response) => {
    const work = (async () => {
      try {
        if (!(validateHost(request, response) && validateOrigin(request, response))) {
          return;
        }
        await dispatch(request, response);
      } catch (error) {
        failures.push(error);
        response.destroy(error instanceof Error ? error : undefined);
      } finally {
        completedRequests += 1;
      }
    })();
    requests.add(work);
    void work.then(() => requests.delete(work));
  });
  server.on('connection', (socket) => {
    sockets.set(
      socket,
      new Promise<void>((resolve) => {
        socket.once('close', () => {
          sockets.delete(socket);
          resolve();
        });
      })
    );
  });
  const snapshot = (): ToolOutputFixtureSnapshot => ({
    activeRequests: requests.size,
    completedRequests,
    handlersClosed,
    httpListenersClosed,
    listening: server.listening,
    openSockets: sockets.size,
    toolCalls,
  });
  let closePromise: ReturnType<ToolOutputFixture['close']> | undefined;
  const close: ToolOutputFixture['close'] = () => {
    closePromise ??= (async () => {
      const closedSockets = [...sockets.values()];
      const listenerClose = server.listening
        ? new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              httpListenersClosed += 1;
              resolve();
            });
            server.closeAllConnections();
          })
        : Promise.resolve();
      const results = await Promise.allSettled([
        listenerClose,
        handler.close().then(() => {
          handlersClosed += 1;
        }),
        ...requests,
        ...closedSockets,
      ]);
      failures.push(
        ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'MCP tool-output fixture failed');
      }
      const report = snapshot();
      if (report.listening || report.activeRequests !== 0 || report.openSockets !== 0) {
        throw new Error('MCP tool-output fixture cleanup is incomplete');
      }
      return { ...report, clean: true as const };
    })();
    return closePromise;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('MCP tool-output fixture has no loopback address');
    }
    const url = `http://127.0.0.1:${address.port}/mcp`;
    return {
      close,
      config: JSON.stringify({
        servers: [{ name: serverName, protocol: 'legacy', transport: 'streamable-http', url }],
      }),
      serverName,
      snapshot,
      toolName,
      url,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'MCP tool-output fixture startup failed');
    }
    throw error;
  }
}
