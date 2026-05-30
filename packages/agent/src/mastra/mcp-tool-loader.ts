import { createLogger } from '@brainstrike/utils/logger';
import type { ToolsInput } from '@mastra/core/agent';
import type { MCPClient } from '@mastra/mcp';
import type { McpConfig } from '../mcp/config';
import { isToolEnabledByFilterConfig, toolRegistry as mcpToolRegistry } from '../mcp/tool-registry';
import { createMastraAgentError } from './mastra-agent-error';
import { sanitizeTools } from './tool-sanitizer';

const logger = createLogger('MastraAgentMcpTools');

const DEFAULT_MCP_TIMEOUT_MS = 5000;

export interface CollectCombinedToolsOptions {
  mcpClient: MCPClient | undefined;
  mcpConfig: McpConfig | undefined;
  sanitizedLocalTools: ToolsInput | undefined;
  timeoutOverrideMs: number | undefined;
  toolNameMap: Map<string, string>;
}

type McpServerConfig = NonNullable<McpConfig['servers']>[number];
type McpToolsets = Record<string, ToolsInput>;

interface McpClientWithToolsets {
  listToolsets: () => Promise<McpToolsets>;
}

type McpToolDiscovery =
  | {
      kind: 'flat';
      tools: ToolsInput;
    }
  | {
      kind: 'toolsets';
      toolsets: McpToolsets;
    };

export async function collectCombinedTools({
  sanitizedLocalTools,
  mcpClient,
  mcpConfig,
  toolNameMap,
  timeoutOverrideMs,
}: CollectCombinedToolsOptions): Promise<ToolsInput> {
  const combined: ToolsInput = sanitizedLocalTools ? { ...sanitizedLocalTools } : {};

  if (!(mcpClient && mcpConfig)) {
    return combined;
  }

  const timeoutMs = resolveMcpTimeoutMs(timeoutOverrideMs);
  const discovered = await fetchMcpToolsWithTimeout(mcpClient, toolNameMap, timeoutMs);
  if (!discovered) {
    return combined;
  }

  const serverList = mcpConfig.servers ?? [];
  const isSingleServer = serverList.length === 1;
  const configuredServerNames = new Set(
    serverList.flatMap((server) => (server?.name ? [server.name] : []))
  );
  const assignedToolsetNames = new Set<string>();

  for (const server of serverList) {
    if (!server?.name) {
      continue;
    }

    const toolsForServer =
      discovered.kind === 'toolsets'
        ? selectToolsetForServer(
            discovered.toolsets,
            server.name,
            isSingleServer,
            toolNameMap,
            configuredServerNames,
            assignedToolsetNames
          )
        : selectToolsForServer(discovered.tools, server.name, isSingleServer);
    if (!toolsForServer || Object.keys(toolsForServer).length === 0) {
      continue;
    }

    const enabled = filterEnabledServerTools(server, toolsForServer, toolNameMap);
    if (enabled) {
      Object.assign(combined, enabled);
    }
  }

  return combined;
}

function selectToolsetForServer(
  toolsets: McpToolsets,
  serverName: string,
  isSingleServer: boolean,
  toolNameMap: Map<string, string>,
  configuredServerNames: Set<string>,
  assignedToolsetNames: Set<string>
): ToolsInput | undefined {
  const selected = findToolsetForServer(toolsets, serverName, isSingleServer);
  if (!selected) {
    const logToolsetDrop = isSingleServer ? logger.debug : logger.warn;
    logToolsetDrop('MCP toolset did not match configured server', {
      code: 'mcp_toolset_server_key_missing',
      serverName,
      availableServerNames: Object.keys(toolsets),
    });
    return;
  }

  if (Object.keys(selected.tools).length === 0) {
    const logToolsetDrop = isSingleServer ? logger.debug : logger.warn;
    logToolsetDrop('MCP toolset matched configured server but contained no tools', {
      code: 'mcp_toolset_server_key_empty',
      serverName,
      matchedServerName: selected.matchedServerName,
    });
    return;
  }

  if (
    selected.matchedServerName !== serverName &&
    configuredServerNames.has(selected.matchedServerName)
  ) {
    logger.debug('MCP toolset matched another configured server exact key', {
      code: 'mcp_toolset_server_key_exact_owner_deferred',
      serverName,
      matchedServerName: selected.matchedServerName,
    });
    return;
  }

  if (assignedToolsetNames.has(selected.matchedServerName)) {
    const logToolsetDrop = isSingleServer ? logger.debug : logger.warn;
    logToolsetDrop('MCP toolset already matched another configured server', {
      code: 'mcp_toolset_server_key_duplicate',
      serverName,
      matchedServerName: selected.matchedServerName,
    });
    return;
  }
  assignedToolsetNames.add(selected.matchedServerName);

  if (selected.matchedServerName !== serverName) {
    logger.debug('MCP toolset matched configured server by compatibility fallback', {
      code: 'mcp_toolset_server_key_fallback',
      serverName,
      matchedServerName: selected.matchedServerName,
    });
  }

  return sanitizeTools(namespaceServerTools(serverName, selected.tools), toolNameMap);
}

function findToolsetForServer(
  toolsets: McpToolsets,
  serverName: string,
  isSingleServer: boolean
): { matchedServerName: string; tools: ToolsInput } | undefined {
  const directTools = toolsets[serverName];
  if (Object.hasOwn(toolsets, serverName)) {
    return { matchedServerName: serverName, tools: directTools ?? {} };
  }

  const toolsetEntries = Object.entries(toolsets).filter(
    ([, tools]) => Object.keys(tools).length > 0
  );
  const normalizedServerName = normalizeMcpServerName(serverName);
  if (normalizedServerName.length === 0) {
    return findSingleServerFallbackToolset(toolsetEntries, isSingleServer);
  }

  const normalizedMatches = toolsetEntries.filter(
    ([toolsetName]) => normalizeMcpServerName(toolsetName) === normalizedServerName
  );
  if (normalizedMatches.length === 1) {
    const match = normalizedMatches[0];
    if (!match) {
      return;
    }
    const [matchedServerName, tools] = match;
    return { matchedServerName, tools };
  }

  if (!isSingleServer) {
    return;
  }

  const fuzzyMatches = toolsetEntries.filter(([toolsetName]) => {
    const normalizedToolsetName = normalizeMcpServerName(toolsetName);
    return (
      normalizedToolsetName.includes(normalizedServerName) ||
      normalizedServerName.includes(normalizedToolsetName)
    );
  });
  if (fuzzyMatches.length === 1) {
    const match = fuzzyMatches[0];
    if (!match) {
      return;
    }
    const [matchedServerName, tools] = match;
    return { matchedServerName, tools };
  }

  return findSingleServerFallbackToolset(toolsetEntries, isSingleServer);
}

function normalizeMcpServerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findSingleServerFallbackToolset(
  toolsetEntries: [string, ToolsInput][],
  isSingleServer: boolean
): { matchedServerName: string; tools: ToolsInput } | undefined {
  if (!(isSingleServer && toolsetEntries.length === 1)) {
    return;
  }

  const match = toolsetEntries[0];
  if (!match) {
    return;
  }

  const [matchedServerName, tools] = match;
  return { matchedServerName, tools };
}

function namespaceServerTools(serverName: string, serverTools: ToolsInput): ToolsInput {
  return Object.fromEntries(
    Object.entries(serverTools).map(([toolId, tool]) => [`${serverName}.${toolId}`, tool])
  );
}

function selectToolsForServer(
  allMcpTools: ToolsInput,
  serverName: string | undefined,
  isSingleServer: boolean
): ToolsInput | undefined {
  const filteredTools = collectServerTools(allMcpTools, serverName);
  return filteredTools ?? (isSingleServer ? allMcpTools : undefined);
}

function collectServerTools(
  allMcpTools: ToolsInput,
  serverName: string | undefined
): ToolsInput | undefined {
  if (!serverName) {
    return;
  }

  const normalized = serverName.toLowerCase();
  const prefix = `${serverName}.`;
  const matches: ToolsInput = {};

  for (const [toolId, tool] of Object.entries(allMcpTools)) {
    const normalizedId = toolId.toLowerCase();
    if (toolId.startsWith(prefix) || normalizedId.includes(normalized)) {
      matches[toolId] = tool;
    }
  }

  return Object.keys(matches).length > 0 ? matches : undefined;
}

function filterEnabledServerTools(
  server: McpServerConfig,
  serverTools: ToolsInput,
  toolNameMap: Map<string, string>
): ToolsInput | undefined {
  // Discovery/registration happens upstream when the desktop client enumerates the server.
  // At runtime we only filter the already-sanitized tool set against persisted state/config.
  const enabledTools = Object.fromEntries(
    Object.entries(serverTools).filter(([sanitizedToolId]) => {
      const candidateToolIds = getRegistryCandidateToolIds(server, sanitizedToolId, toolNameMap);
      const persistedMetadata = candidateToolIds
        .map((toolId) => mcpToolRegistry.getTool(toolId))
        .find((metadata) => metadata !== undefined);

      if (persistedMetadata) {
        return persistedMetadata.enabled;
      }

      return isToolEnabledByFilterConfig(
        candidateToolIds[0] ?? sanitizedToolId,
        server.enabledTools ? { enabledTools: server.enabledTools } : undefined
      );
    })
  );

  return Object.keys(enabledTools).length > 0 ? enabledTools : undefined;
}

function getRegistryCandidateToolIds(
  server: McpServerConfig,
  sanitizedToolId: string,
  toolNameMap: ReadonlyMap<string, string>
): string[] {
  const candidates = new Set<string>();
  const originalToolId = toolNameMap.get(sanitizedToolId) ?? sanitizedToolId;

  if (server.name) {
    const serverPrefix = `${server.name}_`;
    if (sanitizedToolId.startsWith(serverPrefix)) {
      candidates.add(`${server.name}.${sanitizedToolId.slice(serverPrefix.length)}`);
    }
    if (originalToolId.startsWith(serverPrefix)) {
      candidates.add(`${server.name}.${originalToolId.slice(serverPrefix.length)}`);
    }
  }

  candidates.add(originalToolId);
  candidates.add(sanitizedToolId);
  return Array.from(candidates);
}

function resolveMcpTimeoutMs(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_MCP_TIMEOUT_MS;
}

async function fetchMcpToolsWithTimeout(
  mcpClient: MCPClient,
  toolNameMap: Map<string, string>,
  timeoutMs: number
): Promise<McpToolDiscovery | undefined> {
  try {
    return await Promise.race([
      discoverMcpTools(mcpClient, toolNameMap),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              createMastraAgentError('mcp_tool_discovery_timeout', {
                detail: `timeout_${timeoutMs}`,
              })
            ),
          timeoutMs
        );
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const logMethod =
      reason.includes('Connection closed') || reason.includes('mcp_tool_discovery_timeout')
        ? logger.debug.bind(logger)
        : logger.warn.bind(logger);
    logMethod('MCP tool discovery skipped', {
      code: 'mcp_tools_unavailable',
      reason,
      timeoutMs,
    });
    return;
  }
}

async function discoverMcpTools(
  mcpClient: MCPClient,
  toolNameMap: Map<string, string>
): Promise<McpToolDiscovery> {
  if (supportsToolsets(mcpClient)) {
    return {
      kind: 'toolsets',
      toolsets: await mcpClient.listToolsets(),
    };
  }

  return {
    kind: 'flat',
    tools: sanitizeTools(await mcpClient.listTools(), toolNameMap) ?? {},
  };
}

function supportsToolsets(mcpClient: MCPClient): mcpClient is MCPClient & McpClientWithToolsets {
  const candidate = mcpClient as { listToolsets?: unknown };
  return typeof candidate.listToolsets === 'function';
}
