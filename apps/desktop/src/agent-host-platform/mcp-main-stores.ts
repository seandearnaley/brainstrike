import { MCP_STORE_METHODS, respond } from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import type { RemoteMcpRuntime } from '../mcp/remote-runtime';

/** Main's MCP stores that still need Electron or Main's database host (c1 interim). */
export interface DesktopMcpPlatformCapabilities {
  openExternal(url: string): Promise<void>;
  readonly runtime: RemoteMcpRuntime;
}

/**
 * Serve the Node MCP runtime's remaining Main adapters and bind Main's runtime
 * proxy to this host connection. The opener stays a narrow adapter. The host
 * owns its MCP settings, OAuth records and the Tasks tables.
 */
export function serveMainMcpStores(
  connection: MessageConnection,
  capabilities: DesktopMcpPlatformCapabilities
): { close(): void } {
  const binding = capabilities.runtime.bind(connection);
  const handlers = [
    connection.onRequest(MCP_STORE_METHODS.ready, (input: unknown) =>
      respond(() => {
        z.strictObject({}).parse(input);
        return binding.ready();
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
