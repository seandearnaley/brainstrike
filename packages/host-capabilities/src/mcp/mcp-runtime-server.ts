import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { MCP_RUNTIME_METHODS, respond } from './mcp-runtime-wire.js';
import type { McpSettingsAuthority } from './settings-authority.js';

/**
 * Serve Main's requests to the host's MCP settings over the private connection
 * (BST-1930 c5e): the native picker's chosen config file, the factory reset's
 * retire and reopen, and a one-shot read of the tools for persona
 * availability. Main owns no MCP runtime, status, tool registry or settings.
 */
export function serveMcpRuntimeToMain(
  connection: MessageConnection,
  settings: McpSettingsAuthority
): { close(): void } {
  const handlers = [
    connection.onRequest(MCP_RUNTIME_METHODS.configPathPick, (input: unknown) =>
      respond(() => settings.pickConfigPath(z.strictObject({ path: z.string() }).parse(input).path))
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.settingsReset, () => respond(() => settings.reset())),
    connection.onRequest(MCP_RUNTIME_METHODS.settingsResume, (input: unknown) =>
      respond(() =>
        settings.resume(
          z.strictObject({ outcome: z.enum(['failed', 'succeeded']) }).parse(input).outcome
        )
      )
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.toolsRead, (input: unknown) =>
      respond(() => {
        z.strictObject({}).parse(input);
        return settings.tools();
      })
    ),
  ];
  return {
    close: () => {
      for (const handler of handlers) {
        handler.dispose();
      }
    },
  };
}
