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
type McpToolsetsWithErrors = Awaited<ReturnType<MCPClient['listToolsetsWithErrors']>>;

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

  const serverList = mcpConfig.servers ?? [];
  const namedServers = serverList.filter((server) => server?.name);
  if (namedServers.length === 0) {
    return combined;
  }

  const timeoutMs = resolveMcpTimeoutMs(timeoutOverrideMs);
  const discovered = await fetchMcpToolsetsWithTimeout(mcpClient, timeoutMs);
  if (!discovered) {
    return combined;
  }
  logMcpToolsetErrors(discovered.errors, timeoutMs);

  for (const server of namedServers) {
    const toolsForServer = buildSanitizedServerTools(
      discovered.toolsets[server.name],
      server.name,
      toolNameMap
    );
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

function buildSanitizedServerTools(
  serverToolset: ToolsInput | undefined,
  serverName: string,
  toolNameMap: Map<string, string>
): ToolsInput | undefined {
  if (!serverToolset || Object.keys(serverToolset).length === 0) {
    return;
  }
  return sanitizeTools(flattenMcpServerToolset(serverName, serverToolset), toolNameMap);
}

function flattenMcpServerToolset(serverName: string, serverToolset: ToolsInput): ToolsInput {
  const flattened: ToolsInput = {};
  for (const [toolName, tool] of Object.entries(serverToolset)) {
    flattened[`${serverName}.${toolName}`] = tool;
  }
  return flattened;
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

async function fetchMcpToolsetsWithTimeout(
  mcpClient: MCPClient,
  timeoutMs: number
): Promise<McpToolsetsWithErrors | undefined> {
  try {
    return await Promise.race([
      mcpClient.listToolsetsWithErrors(),
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

function logMcpToolsetErrors(errors: Record<string, string>, timeoutMs: number): void {
  for (const [serverName, reason] of Object.entries(errors)) {
    const logMethod =
      reason.includes('Connection closed') || reason.includes('mcp_tool_discovery_timeout')
        ? logger.debug.bind(logger)
        : logger.warn.bind(logger);
    logMethod('MCP server tool discovery skipped', {
      code: 'mcp_server_tools_unavailable',
      reason,
      serverName,
      timeoutMs,
    });
  }
}
