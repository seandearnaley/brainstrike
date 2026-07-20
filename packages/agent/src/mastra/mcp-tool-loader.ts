import { ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import type { ToolsInput } from '@mastra/core/agent';
import type { McpConfig } from '../mcp/config';
import {
  isAnyToolIdEnabledByFilterConfig,
  toolRegistry as mcpToolRegistry,
} from '../mcp/tool-registry';
import { boundToolOutputForModel, MAX_TOOL_RESULT_TOKENS } from '../stream/tool-output-limits';
import { createMastraAgentError } from './mastra-agent-error';
import { measureMcpMultimodalOutput } from './mcp-multimodal-output';
import type { McpRuntimeClient, McpToolsetsWithErrors } from './mcp-runtime-client';
import { sanitizeTools } from './tool-sanitizer';

const logger = createLogger('MastraAgentMcpTools');

const DEFAULT_MCP_TIMEOUT_MS = 5000;
const APPROX_CHARS_PER_TOKEN = 4;
export const MAX_MCP_INLINE_MEDIA_DATA_CHARS =
  Math.ceil(ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES / 3) * 4;
export const MAX_MCP_NON_MEDIA_SERIALIZED_CHARS = MAX_TOOL_RESULT_TOKENS * APPROX_CHARS_PER_TOKEN;

export interface CollectCombinedToolsOptions {
  durableArtifactSettlement?: boolean;
  mcpClient: McpRuntimeClient | undefined;
  mcpConfig: McpConfig | undefined;
  sanitizedLocalTools: ToolsInput | undefined;
  timeoutOverrideMs: number | undefined;
  toolNameMap: Map<string, string>;
}

type McpServerConfig = NonNullable<McpConfig['servers']>[number];
type McpToolsets = Record<string, ToolsInput>;

export async function collectCombinedTools({
  durableArtifactSettlement = false,
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

  const isSingleServer = namedServers.length === 1;
  const configuredServerNames = new Set(namedServers.map((server) => server.name));
  const assignedToolsetNames = new Set<string>();

  for (const server of namedServers) {
    const toolsForServer = selectToolsetForServer(
      discovered.toolsets,
      server.name,
      isSingleServer,
      toolNameMap,
      configuredServerNames,
      assignedToolsetNames
    );
    if (!toolsForServer || Object.keys(toolsForServer).length === 0) {
      continue;
    }

    const enabled = filterEnabledServerTools(server, toolsForServer, toolNameMap);
    if (enabled) {
      Object.assign(combined, wrapMcpToolOutputs(enabled, toolNameMap, durableArtifactSettlement));
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

/**
 * MCP text/JSON remains complete only when the trusted durable settlement seam
 * is present; otherwise it receives the temporary successful-preview ceiling.
 * Model-native media always stays inline for rendering and therefore always
 * keeps the aggregate attachment ceiling plus bounded non-media metadata.
 */
function wrapMcpToolOutputs(
  tools: ToolsInput,
  toolNameMap: ReadonlyMap<string, string>,
  durableArtifactSettlement: boolean
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
      const output = await Promise.resolve(Reflect.apply(originalExecute, cloned, args));
      const multimodalSize = measureMcpMultimodalOutput(output);
      if (!multimodalSize) {
        return durableArtifactSettlement
          ? output
          : boundToolOutputForModel(originalToolName, output).output;
      }
      if (multimodalSize.mediaDataChars > MAX_MCP_INLINE_MEDIA_DATA_CHARS) {
        throw new RangeError(
          `MCP tool ${originalToolName} returned ${multimodalSize.mediaDataChars} inline media characters; ` +
            `the temporary persistence ceiling is ${MAX_MCP_INLINE_MEDIA_DATA_CHARS}`
        );
      }
      if (multimodalSize.nonMediaSerializedChars > MAX_MCP_NON_MEDIA_SERIALIZED_CHARS) {
        throw new RangeError(
          `MCP tool ${originalToolName} returned ${multimodalSize.nonMediaSerializedChars} ` +
            'non-media serialized characters; the temporary persistence ceiling is ' +
            `${MAX_MCP_NON_MEDIA_SERIALIZED_CHARS}`
        );
      }
      return output;
    };
    wrapped[toolId] = cloned;
  }
  return wrapped;
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
      availableServerNames: Object.keys(toolsets),
      code: 'mcp_toolset_server_key_missing',
      serverName,
    });
    return;
  }

  if (Object.keys(selected.tools).length === 0) {
    const logToolsetDrop = isSingleServer ? logger.debug : logger.warn;
    logToolsetDrop('MCP toolset matched configured server but contained no tools', {
      code: 'mcp_toolset_server_key_empty',
      matchedServerName: selected.matchedServerName,
      serverName,
    });
    return;
  }

  if (
    selected.matchedServerName !== serverName &&
    configuredServerNames.has(selected.matchedServerName)
  ) {
    logger.debug('MCP toolset matched another configured server exact key', {
      code: 'mcp_toolset_server_key_exact_owner_deferred',
      matchedServerName: selected.matchedServerName,
      serverName,
    });
    return;
  }

  if (assignedToolsetNames.has(selected.matchedServerName)) {
    const logToolsetDrop = isSingleServer ? logger.debug : logger.warn;
    logToolsetDrop('MCP toolset already matched another configured server', {
      code: 'mcp_toolset_server_key_duplicate',
      matchedServerName: selected.matchedServerName,
      serverName,
    });
    return;
  }
  assignedToolsetNames.add(selected.matchedServerName);

  if (selected.matchedServerName !== serverName) {
    logger.debug('MCP toolset matched configured server by compatibility key normalization', {
      code: 'mcp_toolset_server_key_normalized_match',
      matchedServerName: selected.matchedServerName,
      serverName,
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

      return isAnyToolIdEnabledByFilterConfig(
        candidateToolIds,
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
    const serverDotPrefix = `${server.name}.`;
    if (sanitizedToolId.startsWith(serverPrefix)) {
      const rawToolId = sanitizedToolId.slice(serverPrefix.length);
      candidates.add(`${server.name}.${rawToolId}`);
      candidates.add(rawToolId);
    }
    if (originalToolId.startsWith(serverDotPrefix)) {
      candidates.add(originalToolId.slice(serverDotPrefix.length));
    }
    if (originalToolId.startsWith(serverPrefix)) {
      const rawToolId = originalToolId.slice(serverPrefix.length);
      candidates.add(`${server.name}.${rawToolId}`);
      candidates.add(rawToolId);
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
  mcpClient: McpRuntimeClient,
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
    logMcpDiscoverySkip('MCP tool discovery skipped', {
      code: 'mcp_tools_unavailable',
      reason,
      timeoutMs,
    });
  }
  return;
}

function logMcpToolsetErrors(errors: Record<string, string>, timeoutMs: number): void {
  for (const [serverName, reason] of Object.entries(errors)) {
    logMcpDiscoverySkip('MCP server tool discovery skipped', {
      code: 'mcp_server_tools_unavailable',
      reason,
      serverName,
      timeoutMs,
    });
  }
}

function logMcpDiscoverySkip(
  message: string,
  details: {
    availableServerNames?: string[];
    code: string;
    reason: string;
    serverName?: string;
    timeoutMs: number;
  }
): void {
  const logMethod = pickMcpDiscoveryLogMethod(details.reason);
  logMethod(message, details);
}

function pickMcpDiscoveryLogMethod(reason: string): (...args: unknown[]) => void {
  if (reason.includes('Connection closed') || reason.includes('mcp_tool_discovery_timeout')) {
    return logger.debug.bind(logger);
  }
  return logger.warn.bind(logger);
}
