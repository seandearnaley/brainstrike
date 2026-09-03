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

export async function saveToolPreferencesIfNeeded(): Promise<void> {
  try {
    const tools = getFlattenedTools();
    const enabledTools = tools.filter((t) => t.enabled).map((t) => t.id);
    const disabledTools = tools.filter((t) => !t.enabled).map((t) => t.id);

    await saveToolPreferences(app.getPath('userData'), {
      disabledTools,
      enabledTools,
      lastUpdated: Date.now(),
      version: 1,
    });
  } catch (error) {
    logger.error('Failed to save tool preferences', { error });
  }
}

/**
 * True when `toolId` belongs to a server that is still in the MCP config.
 *
 * Tool ids are `${server.name}.${tool.name}` and a server name may itself
 * contain dots, so this matches on the `${name}.` prefix rather than splitting.
 */
function isFromConfiguredServer(
  toolId: string,
  configuredServerNames: ReadonlySet<string>
): boolean {
  for (const serverName of configuredServerNames) {
    if (toolId.startsWith(`${serverName}.`)) {
      return true;
    }
  }
  return false;
}

/**
 * Projects saved tool preferences onto the tools discovered this run.
 *
 * Two sets, deliberately kept apart (BST-1621):
 *
 * - What we *apply* is scoped to `registeredIds`, because a preference can only
 *   be projected onto a tool that exists in the registry right now.
 * - What we *keep on disk* is scoped to `configuredServerNames`. A server that
 *   timed out, failed `tools/list`, or is still spawning under `npx` is absent
 *   from `registeredIds` through no fault of the user, and BST-1603 measured
 *   that happening routinely. Pruning on that signal silently deleted the
 *   user's choices and handed the tools back enabled on the next successful
 *   run, since `ToolRegistry.register` treats an unseen tool as enabled.
 *
 * Only removal from the MCP config retires an id. With no configured servers we
 * have no authority to retire anything, so nothing is pruned.
 */
export async function loadToolPreferencesForProjection(
  registeredIds: ReadonlySet<string>,
  configuredServerNames: ReadonlySet<string>
): Promise<Pick<ToolPreferences, 'disabledTools' | 'enabledTools'>> {
  try {
    const preferences = await loadToolPreferences(app.getPath('userData'));
    if (!preferences) {
      return { disabledTools: [], enabledTools: [] };
    }

    const projection = {
      disabledTools: preferences.disabledTools.filter((id: string) => registeredIds.has(id)),
      enabledTools: preferences.enabledTools.filter((id: string) => registeredIds.has(id)),
    };

    if (configuredServerNames.size === 0) {
      return projection;
    }

    const keptEnabled = preferences.enabledTools.filter((id: string) =>
      isFromConfiguredServer(id, configuredServerNames)
    );
    const keptDisabled = preferences.disabledTools.filter((id: string) =>
      isFromConfiguredServer(id, configuredServerNames)
    );
    const retiredCount =
      preferences.enabledTools.length -
      keptEnabled.length +
      (preferences.disabledTools.length - keptDisabled.length);

    if (retiredCount > 0) {
      logger.warn('Discarded MCP tool preference ids for servers removed from config', {
        configuredServerCount: configuredServerNames.size,
        retiredCount,
      });

      try {
        await saveToolPreferences(app.getPath('userData'), {
          disabledTools: keptDisabled,
          enabledTools: keptEnabled,
          lastUpdated: Date.now(),
          version: preferences.version,
        });
      } catch (saveError) {
        logger.warn('Failed to persist cleaned tool preferences', { error: saveError });
      }
    }

    return projection;
  } catch (error) {
    logger.error('Failed to load tool preferences', { error });
    return { disabledTools: [], enabledTools: [] };
  }
}
