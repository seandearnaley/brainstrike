import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import {
  MCP_STORE_METHODS,
  type McpDiagnosticEvent,
  McpDiagnosticEventSchema,
  respond,
} from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import type { MessageConnection } from 'vscode-jsonrpc';
import {
  type DesktopPlatformCapabilities,
  serveDesktopPlatform,
} from '../../agent-host-platform/main-platform';

/** Main's diagnostic sink is a separate process in the app; record it here. */
export function serveInProcessDesktopPlatform(
  connection: MessageConnection,
  capabilities: DesktopPlatformCapabilities
): { close(): Promise<void>; readonly diagnostics: readonly McpDiagnosticEvent[] } {
  const owner = serveDesktopPlatform(connection, capabilities);
  const diagnostics: McpDiagnosticEvent[] = [];
  // Replaying Main's records into this process's host tap would feed back forever.
  // Keep the same wire validation/acknowledgement, and retain every actual record.
  const sink = connection.onRequest(MCP_STORE_METHODS.diagnostics, (input: unknown) =>
    respond(() => {
      diagnostics.push(
        wireDecoder(McpDiagnosticEventSchema, { errors: 'all', onExcessProperty: 'error' })(input)
      );
    })
  );
  return {
    close: async () => {
      try {
        await owner.close();
      } finally {
        sink.dispose();
      }
    },
    diagnostics,
  };
}
