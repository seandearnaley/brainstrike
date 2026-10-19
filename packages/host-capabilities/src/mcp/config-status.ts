import type { McpConfigStatus } from '@brainstrike/agent-host/protocol';
import type { LoadedMcpConfig } from './config-file.js';

/**
 * Settings' view of a loaded MCP config: path, load state and server
 * summaries, and `watchError` while the config file watcher cannot run.
 */
export function toMcpConfigStatus(
  config: LoadedMcpConfig,
  watchError: string | null
): McpConfigStatus {
  const servers = config.servers ?? config.config?.servers;
  return {
    exists: config.exists,
    path: config.path,
    ...(config.error === undefined ? {} : { error: config.error }),
    ...(config.loadedAt === undefined ? {} : { loadedAt: config.loadedAt }),
    ...(config.migrations?.length ? { migrations: config.migrations } : {}),
    ...(servers === undefined
      ? {}
      : {
          servers: servers.map(({ name, protocol, transport }) => ({ name, protocol, transport })),
        }),
    ...(watchError === null ? {} : { watchError }),
  };
}
