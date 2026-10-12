import { createServer } from 'node:http';
import { localhostHostValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { asNodeIncomingMessage } from './loopback-http.js';
import { registerElicitConfirmTool } from './reference-server.js';

const APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** The MCP App the reference `elicit_confirm` tool mounts: its document and resource URI. */
export interface ReferenceElicitationApp {
  readonly document: string;
  readonly resourceUri: `ui://${string}`;
}

export interface ReferenceElicitationAppFixture {
  close(): Promise<void>;
  readonly url: string;
}

/**
 * A modern-era (2026-07-28) loopback MCP server whose reference
 * `elicit_confirm` tool carries an MCP App. An app may call only the tool
 * that mounted it, so the app's own call is the reference elicitation itself:
 * a host's server-initiated input can be proven from inside an app.
 */
export async function startReferenceElicitationAppFixture(
  app: ReferenceElicitationApp
): Promise<ReferenceElicitationAppFixture> {
  const failures: unknown[] = [];
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({
        name: 'brainstrike-reference-elicitation-app',
        version: '1.0.0',
      });
      registerElicitConfirmTool(server, { ui: { resourceUri: app.resourceUri } });
      server.registerResource(
        app.resourceUri,
        app.resourceUri,
        { mimeType: APP_MIME_TYPE },
        async () => ({
          contents: [{ mimeType: APP_MIME_TYPE, text: app.document, uri: app.resourceUri }],
        })
      );
      return server;
    },
    { legacy: 'reject' }
  );
  const dispatch = toNodeHandler(handler, { onerror: (error) => failures.push(error) });
  const validateHost = localhostHostValidation();
  const http = createServer((request, response) => {
    if (validateHost(request, response)) {
      dispatch(asNodeIncomingMessage(request), response).catch((error: unknown) => {
        failures.push(error);
        response.destroy();
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  const address = http.address();
  if (!address || typeof address === 'string') {
    await handler.close();
    throw new Error('MCP reference elicitation app fixture has no loopback address');
  }
  return {
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await handler.close();
      if (failures.length > 0) {
        throw new AggregateError(failures, 'MCP reference elicitation app fixture failed');
      }
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}
