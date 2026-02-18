import { createLogger } from '@brainstrike/utils';
import type { ToolsInput } from '@mastra/core/agent';
import type { MCPClient } from '@mastra/mcp';
import type { McpConfig } from '../mcp/config';
import { toolRegistry as mcpToolRegistry } from '../mcp/tool-registry';
import { createMastraAgentError } from './mastra-agent-error';
import { sanitizeTools } from './tool-sanitizer';

const logger = createLogger('MastraAgentMcpTools');

const DEFAULT_MCP_TIMEOUT_MS = 5000;

export interface CollectCombinedToolsOptions {
  sanitizedLocalTools: ToolsInput | undefined;
  mcpClient: MCPClient | undefined;
  mcpConfig: McpConfig | undefined;
  toolNameMap: Map<string, string>;
  timeoutOverrideMs: number | undefined;
}

type McpServerConfig = NonNullable<McpConfig['servers']>[number];

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
  const allMcpTools = await fetchMcpToolsWithTimeout(mcpClient, toolNameMap, timeoutMs);
  if (!allMcpTools) {
    return combined;
  }

  const serverList = mcpConfig.servers ?? [];
  const isSingleServer = serverList.length === 1;

  for (const server of serverList) {
    if (!server) {
      continue;
    }

    const toolsForServer = selectToolsForServer(allMcpTools, server.name, isSingleServer);
    if (!toolsForServer || Object.keys(toolsForServer).length === 0) {
      continue;
    }

    const enabled = registerServerTools(server, toolsForServer);
    if (enabled) {
      Object.assign(combined, enabled);
    }
  }

  return combined;
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

function registerServerTools(
  server: McpServerConfig,
  serverTools: ToolsInput
): ToolsInput | undefined {
  if (!server.name) {
    return;
  }

  const filterConfig = server.enabledTools ? { enabledTools: server.enabledTools } : undefined;
  mcpToolRegistry.register(server.name, serverTools, filterConfig);
  const enabledTools = mcpToolRegistry.getEnabledTools(serverTools);
  return Object.keys(enabledTools).length > 0 ? enabledTools : undefined;
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
): Promise<ToolsInput | undefined> {
  try {
    const toolsFromClient = (await Promise.race([
      mcpClient.listTools(),
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
    ])) as ToolsInput;
    return sanitizeTools(toolsFromClient, toolNameMap);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('MCP tool discovery skipped', {
      code: 'mcp_tools_unavailable',
      reason,
      timeoutMs,
    });
    return;
  }
}
