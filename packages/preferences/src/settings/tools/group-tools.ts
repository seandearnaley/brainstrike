import type { ToolDisplayMetadata, ToolGroup } from './types';

/**
 * Create a tool group from a list of tools.
 */
function createGroup(
  id: string,
  label: string,
  source: 'native' | 'mcp',
  tools: ToolDisplayMetadata[],
  serverName?: string
): ToolGroup {
  return {
    enabledCount: tools.filter((t) => t.enabled).length,
    id,
    label,
    source,
    tools,
    ...(serverName && { serverName }),
  };
}

/**
 * Group tools by source and server.
 */
export function groupTools(tools: ToolDisplayMetadata[]): ToolGroup[] {
  const groups: ToolGroup[] = [];

  // Native tools group
  const nativeTools = tools.filter((t) => t.source === 'native');
  if (nativeTools.length > 0) {
    groups.push(createGroup('native', 'Native Tools', 'native', nativeTools));
  }

  // MCP tools grouped by server
  const byServer = new Map<string, ToolDisplayMetadata[]>();
  for (const tool of tools) {
    if (tool.source !== 'mcp') {
      continue;
    }
    const server = tool.serverName ?? 'unknown';
    const serverTools = byServer.get(server);
    if (serverTools) {
      serverTools.push(tool);
    } else {
      byServer.set(server, [tool]);
    }
  }

  for (const [serverName, serverTools] of byServer) {
    groups.push(createGroup(`mcp-${serverName}`, serverName, 'mcp', serverTools, serverName));
  }

  return groups;
}
