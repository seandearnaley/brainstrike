import type { McpServer } from '../mcp-loader';
import { handleFilesystemList, handleFilesystemRead, handleFilesystemSearch } from './fs-tools';
import { normalizeRootDir, resolveBaseDirFromArgs } from './paths';
import type { McpClient } from './types';

export function createFilesystemClientFromStdio(
  server: Extract<McpServer, { transport: 'stdio' }>
): McpClient {
  const baseDirArg = resolveBaseDirFromArgs(server.args) ?? process.cwd();
  const rootDir = normalizeRootDir(baseDirArg);

  return {
    name: server.name,
    transport: 'stdio',
    // Desktop treats the configured filesystem stdio server as a local filesystem bridge.
    // We do not spawn or speak MCP over stdio here; the server config only declares the
    // allowed root directory and keeps settings aligned with the MCP tooling UI.
    dispose: async () => {},
    async callTool(
      tool: string,
      params?: Record<string, unknown>,
      _opts?: { onProgress?: (payload: unknown) => void }
    ): Promise<unknown> {
      switch (tool) {
        case 'filesystem.list':
          return await handleFilesystemList(params, rootDir);
        case 'filesystem.read':
          return await handleFilesystemRead(params, rootDir);
        case 'filesystem.search':
          return await handleFilesystemSearch(params, rootDir);
        default:
          throw new Error(`Unsupported tool: ${tool}`);
      }
    },
  } satisfies McpClient;
}
