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
  type McpToolPreferencesFaultKind,
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
 * The stored tool states this run's registry is overlaid onto, in file order.
 *
 * `disabledTools` is applied after `enabledTools` so an id listed in both wins
 * as disabled: the schema permits the overlap and re-enabling a tool the user
 * turned off is the harmful direction to guess in.
 */
function readStoredToolStates(preferences: ToolPreferences): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const id of preferences.enabledTools) {
    states.set(id, true);
  }
  for (const id of preferences.disabledTools) {
    states.set(id, false);
  }
  return states;
}

/**
 * Merge the registry's current enabled/disabled split into the stored file.
 *
 * This MERGES rather than replaces (BST-1623). `getAllTools()` holds only the
 * tools discovered on *this* run, so serialising it as the whole file dropped
 * the saved choices of every server whose discovery failed — one toggle wiped
 * a slow or erroring server's preferences, the same absence-vs-failure
 * conflation BST-1621 fixed in the load path. Every stored id is carried
 * through untouched, including ones this run never discovered.
 *
 * This function retires nothing, and holds no notion of what "retired" means —
 * its only contribution is declining to drop what it did not see. Retirement
 * is the projection path's job (`loadToolPreferencesForProjection`), which
 * BST-1621 re-keys onto a server's removal from the MCP config rather than its
 * absence from a discovery pass. Do not add a second retirement rule here:
 * that split is what keeps the two write paths from drifting.
 *
 * `mcp:tools:reset` shares this write, so a reset now resets exactly the tools
 * the Settings list shows — the discovered ones — and leaves an undiscovered
 * server's stored choices alone. That is deliberate: the list cannot show those
 * tools, so a reset cannot be the user consenting to discard them.
 *
 * Refuses the write when the stored file cannot be read (BST-1615): a merge
 * into an unreadable file degrades into exactly the replace this fixes, over
 * the user's only copy. That is not the latched session fault
 * `requireToolPreferencesWritable` covers — the projection pass can have read
 * the file cleanly and the file broken afterwards — so it is read fresh here.
 *
 * Throws on failure (BST-1615). The caller is a user-initiated settings write:
 * swallowing the error here made the IPC resolve successfully while nothing
 * reached disk, so the toggle silently reverted on the next launch.
 */
export async function saveToolPreferencesIfNeeded(): Promise<void> {
  const userDataDir = app.getPath('userData');
  const stored = await loadToolPreferences(userDataDir);

  if (stored.status === 'invalid' || stored.status === 'unreadable') {
    logger.error('MCP tool preferences could not be read; refusing to overwrite them', {
      kind: stored.status,
      path: stored.path,
      reason: stored.reason,
    });
    const cause =
      stored.status === 'invalid' ? 'the file is corrupt' : 'the file could not be read';
    throw new Error(
      `MCP tool preferences could not be read from ${stored.path} — ${cause} (${stored.reason}). Your tool change was not saved; the file is left untouched so your saved choices can be recovered. Repair or remove that file and restart the app.`
    );
  }

  const states =
    stored.status === 'loaded'
      ? readStoredToolStates(stored.preferences)
      : new Map<string, boolean>();
  for (const tool of getFlattenedTools()) {
    states.set(tool.id, tool.enabled);
  }

  const enabledTools: string[] = [];
  const disabledTools: string[] = [];
  for (const [id, enabled] of states) {
    (enabled ? enabledTools : disabledTools).push(id);
  }

  try {
    await saveToolPreferences(userDataDir, {
      disabledTools,
      enabledTools,
      lastUpdated: Date.now(),
      version: stored.status === 'loaded' ? stored.preferences.version : 1,
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
  | { status: 'unavailable'; kind: McpToolPreferencesFaultKind; path: string; reason: string }
  /**
   * No tools were discovered, so the preferences file was not read this pass.
   * Never returned by `loadToolPreferencesForProjection` — only synthesized by
   * the caller. It is NOT a synonym for `available`: a pass that never opened
   * the file cannot clear a latched fault, or a config load that discovers no
   * tools would un-block writes over a file still known to be broken.
   */
  | { status: 'not-read' };

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
