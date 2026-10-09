import { MCP_STORE_METHODS, respond } from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import type { MainMcpHostControl } from '../mcp/main-host-control';

/** Main's MCP adapters for the Node host: Electron's opener and Main's host control. */
export interface DesktopMcpPlatformCapabilities {
  readonly control: MainMcpHostControl;
  openExternal(url: string): Promise<void>;
}

/**
 * Serve the Node MCP host's Main adapter (Electron's external opener) and bind
 * Main's MCP host control to this host connection once the host is ready.
 */
export function serveMainMcpStores(
  connection: MessageConnection,
  capabilities: DesktopMcpPlatformCapabilities
): { close(): void } {
  const binding = capabilities.control.bind(connection);
  const handlers = [
    connection.onRequest(MCP_STORE_METHODS.ready, (input: unknown) =>
      respond(() => {
        z.strictObject({}).parse(input);
        binding.ready();
      })
    ),
    connection.onRequest(MCP_STORE_METHODS.openExternal, (input: unknown) =>
      respond(() => capabilities.openExternal(z.strictObject({ url: z.url() }).parse(input).url))
    ),
  ];
  return {
    close: () => {
      binding.close();
      for (const handler of handlers) {
        handler.dispose();
      }
    },
  };
}
