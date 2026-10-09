import type { PgliteMcpTaskRows } from '@brainstrike/db';
import { MCP_STORE_METHODS, respond } from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import type { RemoteMcpRuntime } from '../mcp/remote-runtime';

/** Main's MCP stores that still need Electron or Main's database host (c1 interim). */
export interface DesktopMcpPlatformCapabilities {
  openExternal(url: string): Promise<void>;
  /** Main's PGlite Tasks rows, read once for the host's import (`readPgliteMcpTaskRows`). */
  readLegacyTasks(): Promise<PgliteMcpTaskRows>;
  readonly runtime: RemoteMcpRuntime;
}

/**
 * Serve the Node MCP runtime's store adapters and bind Main's runtime proxy to
 * this host connection. The config adapter goes with host-owned config; the
 * opener stays a narrow adapter. The host owns its OAuth records and the Tasks
 * tables, and reads Main's legacy PGlite rows once to import them.
 */
export function serveMainMcpStores(
  connection: MessageConnection,
  capabilities: DesktopMcpPlatformCapabilities
): { close(): void } {
  const binding = capabilities.runtime.bind(connection);
  const handlers = [
    connection.onRequest(MCP_STORE_METHODS.state, () =>
      respond(() => capabilities.runtime.desiredState())
    ),
    connection.onRequest(MCP_STORE_METHODS.ready, (input: unknown) =>
      respond(() =>
        binding.ready(
          z.strictObject({ revision: z.number().int().nonnegative() }).parse(input).revision
        )
      )
    ),
    connection.onRequest(MCP_STORE_METHODS.openExternal, (input: unknown) =>
      respond(() => capabilities.openExternal(z.strictObject({ url: z.url() }).parse(input).url))
    ),
    connection.onRequest(MCP_STORE_METHODS.tasksLegacy, (input: unknown) =>
      respond(() => {
        z.strictObject({}).parse(input);
        return capabilities.readLegacyTasks();
      })
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
