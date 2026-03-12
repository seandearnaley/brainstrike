interface McpServerLike {
  name?: string;
  transport: 'sse' | 'stdio';
}

interface McpConfigLike<TServer extends McpServerLike> {
  servers: TServer[];
}

export function isDesktopFilesystemBridgeServer(server: McpServerLike): boolean {
  return server.transport === 'stdio' && server.name?.trim().toLowerCase() === 'filesystem';
}

export function filterDesktopMastraMcpConfig<TServer extends McpServerLike>(
  config: McpConfigLike<TServer> | undefined
): McpConfigLike<TServer> | undefined {
  if (!config) {
    return;
  }

  const servers = config.servers.filter((server) => !isDesktopFilesystemBridgeServer(server));
  if (servers.length === 0) {
    return;
  }

  return { servers };
}
