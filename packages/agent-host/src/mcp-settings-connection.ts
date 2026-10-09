import { ErrorCodes, type MessageConnection, ResponseError } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.js';
import type { HostClientOrigin, HostMcpSettingsService } from './ports.js';
import { MCP_SETTINGS_EVENT, McpSettingsEventSchema } from './protocol-mcp-settings.js';

const APPLIED = { applied: true } as const;
const MAX_VISIBLE_ERROR_CHARS = 1000;

/**
 * The desktop's MCP settings on one authenticated connection (BST-1930 c5a).
 * Only the desktop's private client reaches them: the config file, extension
 * dials and tool preferences are the desktop profile's, never a CLI's.
 * `mcp/settings/subscribe` answers the current snapshot and starts this
 * connection's `mcp/settings/event` stream until it closes.
 */
export function bindHostMcpSettingsMethods(
  handle: HostMethodHandler,
  connection: MessageConnection,
  settings: HostMcpSettingsService | undefined,
  origin: HostClientOrigin
): { dispose(): void } {
  let unsubscribe: (() => void) | undefined;
  const service = (): HostMcpSettingsService => {
    if (origin !== 'desktop-ui') {
      throw new Error("MCP settings are available only to the desktop's private client");
    }
    if (!settings) {
      throw new Error('This host owns no MCP settings');
    }
    return settings;
  };
  // Settings shows each refusal (a fault, an invalid path) as the host wrote it.
  const visible = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      throw new ResponseError(
        ErrorCodes.InternalError,
        cause instanceof Error
          ? cause.message.slice(0, MAX_VISIBLE_ERROR_CHARS)
          : 'MCP settings request failed.'
      );
    }
  };
  handle('mcp/settings/subscribe', () =>
    visible(async () => {
      const owner = service();
      unsubscribe ??= owner.subscribe((event) => {
        connection
          .sendNotification(MCP_SETTINGS_EVENT, McpSettingsEventSchema.parse(event))
          .catch(() => connection.dispose());
      });
      return await owner.snapshot();
    })
  );
  handle('mcp/config/status', () => visible(() => service().configStatus()));
  handle('mcp/config/path', () => visible(() => service().configPath()));
  handle('mcp/config/path/set', (params) => visible(() => service().setConfigPath(params)));
  handle('mcp/config/read', () => visible(() => service().readConfigText()));
  handle('mcp/config/write', (params) => visible(() => service().writeConfigText(params)));
  handle('mcp/config/sample', () => visible(() => service().createSampleConfig()));
  handle('mcp/extensions/read', () => visible(() => service().extensions()));
  handle('mcp/extensions/set', (params) => visible(() => service().setExtensions(params)));
  handle('mcp/tools/list', () => visible(() => service().tools()));
  handle('mcp/tools/stats', () => visible(() => service().toolStats()));
  handle('mcp/tools/set', (params) =>
    visible(async () => {
      await service().setToolsEnabled(params);
      return APPLIED;
    })
  );
  handle('mcp/tools/server/set', (params) =>
    visible(async () => {
      await service().setServerToolsEnabled(params);
      return APPLIED;
    })
  );
  handle('mcp/tools/reset', () =>
    visible(async () => {
      await service().resetTools();
      return APPLIED;
    })
  );
  handle('mcp/tools/reload', () =>
    visible(async () => {
      await service().reloadToolPreferences();
      return APPLIED;
    })
  );
  return {
    dispose: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
