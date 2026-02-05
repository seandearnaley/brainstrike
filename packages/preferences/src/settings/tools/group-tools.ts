import type { ToolDisplayMetadata, ToolGroup } from './types';

/**
 * Group tools by source and server.
 */
export function groupTools(tools: ToolDisplayMetadata[]): ToolGroup[] {
  const groups: ToolGroup[] = [];

  // Native tools group
  const nativeTools = tools.filter((t) => t.source === 'native');
  if (nativeTools.length > 0) {
    groups.push({
      id: 'native',
      label: 'Native Tools',
      source: 'native',
      tools: nativeTools,
      enabledCount: nativeTools.filter((t) => t.enabled).length,
    });
  }

  // MCP tools grouped by server
  const mcpTools = tools.filter((t) => t.source === 'mcp');
  const byServer = new Map<string, ToolDisplayMetadata[]>();
  for (const tool of mcpTools) {
    const server = tool.serverName ?? 'unknown';
    const existing = byServer.get(server) ?? [];
    existing.push(tool);
    byServer.set(server, existing);
  }

  for (const [serverName, serverTools] of byServer) {
    groups.push({
      id: `mcp-${serverName}`,
      label: serverName,
      source: 'mcp',
      serverName,
      tools: serverTools,
      enabledCount: serverTools.filter((t) => t.enabled).length,
    });
  }

  return groups;
}
