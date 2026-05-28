import { createLogger } from '@brainstrike/utils/logger';
import type { ToolsInput } from '@mastra/core/agent';
import type { MCPClient } from '@mastra/mcp';
import type { McpConfig } from '../mcp/config';
import { isToolEnabledByFilterConfig, toolRegistry as mcpToolRegistry } from '../mcp/tool-registry';
import { boundToolOutputForModel } from '../stream/tool-output-limits';
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
    if (!server?.name) {
      continue;
    }

    const toolsForServer = selectToolsForServer(allMcpTools, server.name, isSingleServer);
    if (!toolsForServer || Object.keys(toolsForServer).length === 0) {
      continue;
    }

    const enabled = filterEnabledServerTools(server, toolsForServer, toolNameMap);
    if (enabled) {
      Object.assign(combined, wrapMcpToolOutputs(enabled, toolNameMap));
    }
  }

  return combined;
}

type ExecutableTool = ToolsInput[string] & {
  execute: (...args: unknown[]) => unknown;
};

function isExecutableTool(tool: ToolsInput[string]): tool is ExecutableTool {
  return typeof (tool as { execute?: unknown }).execute === 'function';
}

function wrapMcpToolOutputs(
  tools: ToolsInput,
  toolNameMap: ReadonlyMap<string, string>
): ToolsInput {
  const wrapped: ToolsInput = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    if (!isExecutableTool(tool)) {
      wrapped[toolId] = tool;
      continue;
    }

    const originalExecute = tool.execute;
    const originalToolName = toolNameMap.get(toolId) ?? toolId;
    const cloned = Object.create(Object.getPrototypeOf(tool)) as ExecutableTool;
    Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));
    cloned.execute = async (...args: unknown[]): Promise<unknown> => {
      const output = await Promise.resolve(Reflect.apply(originalExecute, tool, args));
      return boundToolOutputForModel(originalToolName, output).output;
    };
    wrapped[toolId] = cloned;
  }
  return wrapped;
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
