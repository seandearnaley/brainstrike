import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The launching desktop's app paths for a disposable profile: its `mcp/` holds the MCP settings. */
export function desktopAppPaths(userDataPath: string) {
  return { isPackaged: false, resourcesPath: userDataPath, userDataPath };
}

/** The profile's MCP config, as the Settings editor saves it and the agent host loads it. */
export async function writeDesktopMcpConfig(
  userDataPath: string,
  servers: readonly Record<string, unknown>[]
): Promise<void> {
  const configPath = path.join(userDataPath, 'mcp', 'mcp.config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ servers }), 'utf8');
}
