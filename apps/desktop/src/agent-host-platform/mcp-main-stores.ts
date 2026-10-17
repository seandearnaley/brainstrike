import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import {
  MCP_STORE_METHODS,
  McpDiagnosticEventSchema,
  respond,
} from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import { createLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { MainMcpHostControl } from '../mcp/main-host-control';

const logger = createLogger('DesktopNodeMcpHost');

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
    connection.onRequest(MCP_STORE_METHODS.diagnostics, (input: unknown) =>
      respond(() => {
        const event = wireDecoder(McpDiagnosticEventSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        if (event.type === 'record') {
          const { args, level, scope } = event.record;
          createLogger(scope)[level](...args);
          return;
        }
        // Main's existing logger owns the file and durable diagnostic sinks.
        // A receipt is accepted only after the host has joined successful cleanup.
        logger.info(`MCP runtime ${event.type} cleanup completed`, {
          hostCloseReport: event.hostCloseReport,
          legacyClientsClosed: true,
          ...(event.type === 'reset' ? { snapshot: event.snapshot } : {}),
        });
      })
    ),
    connection.onRequest(MCP_STORE_METHODS.ready, (input: unknown) =>
      respond(() => {
        wireDecoder(Schema.Record(Schema.String, Schema.Never), {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        binding.ready();
      })
    ),
    connection.onRequest(MCP_STORE_METHODS.openExternal, (input: unknown) =>
      respond(() =>
        capabilities.openExternal(
          wireDecoder(
            Schema.Struct({
              url: Schema.Trim.check(
                Schema.makeFilter((value) => (URL.canParse(value) ? undefined : 'Invalid URL'))
              ),
            }),
            { errors: 'all', onExcessProperty: 'error' }
          )(input).url
        )
      )
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
