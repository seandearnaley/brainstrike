import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';

interface SdkHandler {
  close(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

interface SdkServer {
  registerResource(
    name: string,
    uri: string,
    config: { mimeType: string },
    read: () => Promise<{ contents: Array<{ mimeType: string; text: string; uri: string }> }>
  ): void;
  registerTool(
    name: string,
    config: { _meta: Record<string, unknown>; description: string; inputSchema: unknown },
    execute: (input: {
      source: string;
    }) => Promise<{ content: Array<{ text: string; type: 'text' }> }>
  ): void;
}

// The lab's pinned SDK, as the tool-output fixture resolves it: a test-only
// serving surface whose protocol handling all belongs to the SDK.
const requireLab = createRequire(
  new URL('../../../../packages/mcp-test-lab/package.json', import.meta.url)
);

const APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_APP_FIXTURE_SERVER = 'counter';
export const MCP_APP_FIXTURE_TOOL = 'increment';
const RESOURCE_URI = 'ui://counter/app.html';

/**
 * The app the tool's result mounts. It initializes (retrying until the host's
 * frame bridge has connected and answers), then calls its own tool once and
 * shows the outcome, exactly as an MCP App's button would.
 */
const APP_DOCUMENT = `<!doctype html><body>Starting</body><script>
  const send = (message) => top.postMessage(message, '*');
  let attempt = 0;
  let initialized = false;
  const initialize = () => {
    if (initialized) return;
    attempt += 1;
    send({ id: 'init-' + attempt, jsonrpc: '2.0', method: 'ui/initialize', params: {
      appCapabilities: {}, appInfo: { name: 'counter', version: '1.0.0' }, protocolVersion: '2026-01-26' } });
    setTimeout(initialize, 500);
  };
  addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== top || !message || typeof message !== 'object') return;
    if (String(message.id).startsWith('init-') && message.result && !initialized) {
      initialized = true;
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
      send({ id: 'call', jsonrpc: '2.0', method: 'tools/call',
        params: { arguments: { source: 'app' }, name: '${MCP_APP_FIXTURE_TOOL}' } });
    }
    if (message.id === 'call') {
      document.body.textContent = message.error
        ? 'App call failed: ' + message.error.message
        : 'App call returned: ' + message.result.content[0].text;
    }
  });
  initialize();
</script>`;

export interface McpAppFixture {
  /** Each `tools/call` the server answered, by its `source` argument, in order. */
  calls(): readonly string[];
  close(): Promise<void>;
  readonly url: string;
}

/** A loopback MCP server with one app tool whose result mounts an app that calls it. */
export async function startMcpAppFixture(): Promise<McpAppFixture> {
  const sdk = requireLab('@modelcontextprotocol/server');
  const createMcpHandler = sdk.createMcpHandler as (
    factory: () => SdkServer,
    options: { legacy: 'stateless' }
  ) => SdkHandler;
  const McpServer = sdk.McpServer as new (identity: { name: string; version: string }) => SdkServer;
  const { z } = requireLab('zod') as {
    z: { object(shape: Record<string, unknown>): unknown; string(): unknown };
  };
  const node = requireLab('@modelcontextprotocol/node') as {
    localhostHostValidation(): (request: IncomingMessage, response: ServerResponse) => boolean;
    toNodeHandler(
      handler: SdkHandler,
      options: { onerror: (error: Error) => void }
    ): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  };
  const calls: string[] = [];
  const failures: unknown[] = [];
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: MCP_APP_FIXTURE_SERVER, version: '1.0.0' });
      mcp.registerTool(
        MCP_APP_FIXTURE_TOOL,
        {
          _meta: { ui: { resourceUri: RESOURCE_URI } },
          description: 'Increment the counter and show it in its app.',
          inputSchema: z.object({ source: z.string() }),
        },
        async ({ source }) => {
          calls.push(source);
          return { content: [{ text: `count ${calls.length}`, type: 'text' }] };
        }
      );
      mcp.registerResource(RESOURCE_URI, RESOURCE_URI, { mimeType: APP_MIME_TYPE }, async () => ({
        contents: [{ mimeType: APP_MIME_TYPE, text: APP_DOCUMENT, uri: RESOURCE_URI }],
      }));
      return mcp;
    },
    { legacy: 'stateless' }
  );
  const dispatch = node.toNodeHandler(handler, { onerror: (error) => failures.push(error) });
  const validateHost = node.localhostHostValidation();
  const server = createServer((request, response) => {
    if (validateHost(request, response)) {
      dispatch(request, response).catch((error: unknown) => {
        failures.push(error);
        response.destroy();
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('MCP App fixture has no loopback address');
  }
  return {
    calls: () => [...calls],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handler.close();
      if (failures.length > 0) {
        throw new AggregateError(failures, 'MCP App fixture failed');
      }
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}
