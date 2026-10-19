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
import {
  PLATFORM_DIAGNOSTICS_RECORD_METHOD,
  PlatformDiagnosticRecordSchema,
} from '../../agent-host-platform/platform-wire';

type HostDiagnosticRecord = (typeof PlatformDiagnosticRecordSchema)['Type']['record'];

/** Main's diagnostic sink is a separate process in the app; record it here. */
export function serveInProcessDesktopPlatform(
  connection: MessageConnection,
  capabilities: DesktopPlatformCapabilities
): {
  close(): Promise<void>;
  readonly diagnostics: readonly McpDiagnosticEvent[];
  /** BST-2202: the agent host's forwarded error records, as Main received them. */
  readonly hostDiagnostics: readonly HostDiagnosticRecord[];
} {
  const owner = serveDesktopPlatform(connection, capabilities);
  const diagnostics: McpDiagnosticEvent[] = [];
  const hostDiagnostics: HostDiagnosticRecord[] = [];
  // Replaying Main's records into this process's host tap would feed back forever.
  // Keep the same wire validation/acknowledgement, and retain every actual record.
  const sinks = [
    connection.onRequest(MCP_STORE_METHODS.diagnostics, (input: unknown) =>
      respond(() => {
        diagnostics.push(
          wireDecoder(McpDiagnosticEventSchema, { errors: 'all', onExcessProperty: 'error' })(input)
        );
      })
    ),
    connection.onRequest(PLATFORM_DIAGNOSTICS_RECORD_METHOD, (input: unknown) =>
      respond(() => {
        hostDiagnostics.push(
          wireDecoder(PlatformDiagnosticRecordSchema, {
            errors: 'all',
            onExcessProperty: 'error',
          })(input).record
        );
        return null;
      })
    ),
  ];
  return {
    close: async () => {
      try {
        await owner.close();
      } finally {
        for (const sink of sinks) {
          sink.dispose();
        }
      }
    },
    diagnostics,
    hostDiagnostics,
  };
}
