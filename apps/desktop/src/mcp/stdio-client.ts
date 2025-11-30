import { type ChildProcess, spawn } from 'node:child_process';
import type { McpServer } from '../mcp-loader';
import { handleFilesystemList, handleFilesystemRead, handleFilesystemSearch } from './fs-tools';
import { normalizeRootDir, resolveBaseDirFromArgs } from './paths';
import type { McpClient } from './types';

export function createFilesystemClientFromStdio(
  server: Extract<McpServer, { transport: 'stdio' }>
): McpClient {
  const baseDirArg = resolveBaseDirFromArgs(server.args) ?? process.cwd();
  const rootDir = normalizeRootDir(baseDirArg);
  let child: ChildProcess | null = null;
  try {
    child = spawn(server.command, server.args ?? [], {
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } catch {}

  return {
    name: server.name,
    transport: 'stdio',
    dispose: async () => {
      try {
        if (child) {
          child.kill();
        }
      } catch {}
    },
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
