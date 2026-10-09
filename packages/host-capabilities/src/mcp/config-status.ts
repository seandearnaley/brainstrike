import type { McpConfigStatus } from '@brainstrike/agent-host/protocol';
import type { LoadedMcpConfig } from './config-file.js';

/** Settings' view of a loaded MCP config: path, load state and server summaries. */
export function toMcpConfigStatus(config: LoadedMcpConfig): McpConfigStatus {
  const status: McpConfigStatus = {
    exists: config.exists,
    path: config.path,
  };
  if (config.error !== undefined) {
    status.error = config.error;
  }
  if (config.loadedAt !== undefined) {
    status.loadedAt = config.loadedAt;
  }
  if (config.migrations && config.migrations.length > 0) {
    status.migrations = config.migrations;
  }
  const servers = config.servers ?? config.config?.servers;
  if (servers !== undefined) {
    status.servers = servers.map(({ name, protocol, transport }) => ({
      name,
      protocol,
      transport,
    }));
  }
  return status;
}
