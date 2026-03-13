interface StdioMcpServerLike {
  args?: readonly string[] | undefined;
  command: string;
  transport: 'stdio';
}

interface SseMcpServerLike {
  transport: 'sse';
}

type McpServerLike = SseMcpServerLike | StdioMcpServerLike;

interface McpConfigLike<TServer extends McpServerLike> {
  servers: TServer[];
}

export function isDesktopFilesystemBridgeServer(server: McpServerLike): boolean {
  if (server.transport !== 'stdio') {
    return false;
  }

  const normalizedCommand = server.command.trim().toLowerCase();
  const normalizedArgs = server.args?.map((arg) => arg.trim().toLowerCase()) ?? [];
  const runsFilesystemServer =
    normalizedCommand === 'npx' &&
    normalizedArgs.includes('@modelcontextprotocol/server-filesystem');

  return runsFilesystemServer;
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
