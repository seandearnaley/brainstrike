/**
 * MCP tool discovery and tool-preference projection, split out of
 * `ipc-mcp.ts` to keep that file within its size budget (BST-1604). Pure
 * helpers over the host port and the on-disk tool preferences: no config
 * lifecycle state lives here.
 */
import {
  loadToolPreferences,
  mcpToolRegistry,
  saveToolPreferences,
  type ToolPreferences,
} from '@brainstrike/agent';
import {
  type McpHostPort,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import type { McpServer, ResolvedMcpConfig, ResolvedMcpServer } from '../mcp-loader';
import type { McpDiscoveredTool } from './types';

const logger = createLogger('DesktopMcpToolDiscovery');
const LEGACY_PLACEHOLDER_STDIO_ARG = 'path/to/your/mcp-server.js';
const LEGACY_PLACEHOLDER_SSE_URL = 'https://example.com/mcp/sse';

function normalizeUrl(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/u, '');
}

function isPlaceholderServer(server: McpServer): boolean {
  if (server.transport === 'stdio') {
    const args = server.args ?? [];
    // Backward-compatibility guard for legacy sample configs created before we switched
    // to commented examples. Match exact sentinel values to avoid false positives.
    return args.some((arg) => arg.trim() === LEGACY_PLACEHOLDER_STDIO_ARG);
  }
  if (server.transport === 'sse') {
    return normalizeUrl(server.url) === normalizeUrl(LEGACY_PLACEHOLDER_SSE_URL);
  }
  return false;
}

export interface DiscoveredServerTools {
  server: ResolvedMcpServer;
  tools: Record<string, McpDiscoveredTool>;
}

export async function discoverToolsFromConfig(
  runtime: { readonly host: Pick<McpHostPort, 'invoke'> },
  config: ResolvedMcpConfig,
  committed: McpHostSnapshot
): Promise<DiscoveredServerTools[]> {
  if (!config || config.servers.length === 0) {
    logger.debug('No MCP servers configured, skipping tool discovery');
    return [];
  }

  const committedIds = new Set(committed.servers.map((server) => server.configuredServerId));
  const committedById = new Map(
    committed.servers.map((server) => [server.configuredServerId, server] as const)
  );
  const actionableServers = config.servers.filter(
    (server) =>
      committedIds.has(parseConfiguredMcpServerId(server.name)) &&
      committedById.get(parseConfiguredMcpServerId(server.name))?.state !==
        'authentication-required' &&
      !isPlaceholderServer(server)
  );
  const skippedPlaceholderServers = config.servers
    .filter((server) => isPlaceholderServer(server))
    .map((server) => server.name);

  if (skippedPlaceholderServers.length > 0) {
    logger.warn('Skipping placeholder MCP servers from discovery', {
      skippedServers: skippedPlaceholderServers,
    });
  }

  if (actionableServers.length === 0) {
    logger.debug('No actionable MCP servers configured after filtering placeholders');
    return [];
  }

  logger.info('Starting tool discovery', {
    serverCount: actionableServers.length,
    servers: actionableServers.map((server) => server.name),
  });

  const discoveries = await Promise.all(
    actionableServers.map(async (server): Promise<DiscoveredServerTools | undefined> => {
      const configuredServerId = parseConfiguredMcpServerId(server.name);
      try {
        const result = await runtime.host.invoke({
          configuredServerId,
          type: 'tools/list',
        });
        if (result.type !== 'tools/list') {
          throw new Error('MCP host returned a non-tools result for tools/list discovery');
        }
        const toolNames = new Set<string>();
        const tools: Record<string, McpDiscoveredTool> = Object.fromEntries(
          result.result.tools.map((tool) => {
            if (toolNames.has(tool.name)) {
              throw new Error(`MCP server returned duplicate tool '${tool.name}'`);
            }
            toolNames.add(tool.name);
            return [
              `${server.name}.${tool.name}`,
              {
                ...(tool.description ? { description: tool.description } : {}),
                ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
              },
            ];
          })
        );
        return { server, tools };
      } catch (error) {
        logger.warn('MCP server discovery failed; skipping server', {
          error: error instanceof Error ? error.message : String(error),
          server: server.name,
        });
        return undefined;
      }
    })
  ).then((results) =>
    results.filter((discovery): discovery is DiscoveredServerTools => discovery !== undefined)
  );

  logger.info('Tool discovery complete', {
    servers: discoveries.length,
    tools: discoveries.reduce((count, discovery) => count + Object.keys(discovery.tools).length, 0),
  });
  return discoveries;
}

/**
 * Flattens the registry's grouped tools into a single array.
 */
function getFlattenedTools(): Array<{ id: string; enabled: boolean }> {
  const allTools = mcpToolRegistry.getAllTools();
  return Object.values(allTools).filter(Array.isArray).flat();
}

/**
 * Persist the registry's current enabled/disabled split.
 *
 * Throws on failure (BST-1615). The caller is a user-initiated settings write:
 * swallowing the error here made the IPC resolve successfully while nothing
 * reached disk, so the toggle silently reverted on the next launch.
 */
export async function saveToolPreferencesIfNeeded(): Promise<void> {
  const tools = getFlattenedTools();
  const enabledTools = tools.filter((t) => t.enabled).map((t) => t.id);
  const disabledTools = tools.filter((t) => !t.enabled).map((t) => t.id);

  try {
    await saveToolPreferences(app.getPath('userData'), {
      disabledTools,
      enabledTools,
      lastUpdated: Date.now(),
      version: 1,
    });
  } catch (error) {
    logger.error('Failed to save tool preferences', { error });
    throw error;
  }
}

/**
 * The tool-preference projection to apply after discovery.
 *
 * `unavailable` means the preferences file exists but could not be read. The
 * caller must NOT fall back to "no preferences": an unseen tool registers as
 * enabled, so that fallback re-enables everything the user had turned off, and
 * the next toggle would flush that reset over their only copy of the file.
 */
export type ToolPreferenceProjection =
  | { status: 'available'; disabledTools: string[]; enabledTools: string[] }
  | { status: 'unavailable'; kind: 'invalid' | 'unreadable'; path: string; reason: string };

export async function loadToolPreferencesForProjection(
  registeredIds: ReadonlySet<string>
): Promise<ToolPreferenceProjection> {
  const userDataDir = app.getPath('userData');
  const result = await loadToolPreferences(userDataDir);

  if (result.status === 'invalid' || result.status === 'unreadable') {
    logger.error('MCP tool preferences could not be read; refusing to reset tool state', {
      kind: result.status,
      path: result.path,
      reason: result.reason,
    });
    return {
      kind: result.status,
      path: result.path,
      reason: result.reason,
      status: 'unavailable',
    };
  }

  if (result.status === 'absent') {
    return { disabledTools: [], enabledTools: [], status: 'available' };
  }

  const preferences: ToolPreferences = result.preferences;
  const validEnabled = preferences.enabledTools.filter((id: string) => registeredIds.has(id));
  const validDisabled = preferences.disabledTools.filter((id: string) => registeredIds.has(id));

  const staleCount =
    preferences.enabledTools.length -
    validEnabled.length +
    preferences.disabledTools.length -
    validDisabled.length;

  if (staleCount > 0) {
    logger.warn('Discarded stale MCP tool preference ids', {
      registeredCount: registeredIds.size,
      staleCount,
    });

    try {
      await saveToolPreferences(userDataDir, {
        disabledTools: validDisabled,
        enabledTools: validEnabled,
        lastUpdated: Date.now(),
        version: preferences.version,
      });
    } catch (saveError) {
      // Best-effort housekeeping over an already-readable file: the projection
      // below is still exactly what the user chose, so a failed rewrite only
      // means the stale ids survive to the next load.
      logger.warn('Failed to persist cleaned tool preferences', { error: saveError });
    }
  }

  return { disabledTools: validDisabled, enabledTools: validEnabled, status: 'available' };
}
