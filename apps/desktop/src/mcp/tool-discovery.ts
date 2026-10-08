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
import type { McpDiscoveredTool } from '@brainstrike/host-capabilities/mcp/types';
import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import type { McpServer, ResolvedMcpConfig, ResolvedMcpServer } from '../mcp-loader';

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
 * The version stamp this build writes.
 *
 * Deliberately a constant rather than an echo of the stored file's stamp: the
 * body serialised below is always the shape THIS code emits, so labelling it
 * with a version it was not written in is wrong in both directions. Echoing a
 * newer stamp would mark v1-shaped data as already migrated and no future
 * migration could detect it. The version is a property of the writer.
 */
const TOOL_PREFERENCES_VERSION = 1;

/**
 * Serialises every read-modify-write of `tool-preferences.json`.
 *
 * The file has two writers on DIFFERENT queues, so they genuinely interleave
 * (verified, not assumed): the toggle path runs under `trackConfigOperation`,
 * which serialises on `mcpConfigOperationTail`, while the config-watch path
 * reaches `loadToolPreferencesForProjection` through `trackConfigChange` ->
 * `registerConfigChange`, which only records into `mcpLifecycleBarrier` and
 * does not serialise execution. `latestAuthorityEpoch` narrows the window but
 * cannot close it: that check runs once at operation entry, before the I/O.
 *
 * Unserialised, the lost update is: toggle reads the file -> the projection
 * pass prunes and rewrites -> the toggle writes its now-stale merged map and
 * resurrects every id the prune just removed. Both writers take this lock.
 */
let toolPreferencesFileQueue: Promise<unknown> = Promise.resolve();

export function withToolPreferencesFileLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = toolPreferencesFileQueue.then(operation, operation);
  toolPreferencesFileQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** How a tool-preference mutation should reach disk. */
export type ToolPreferenceWriteIntent =
  /** A toggle: preserve every stored id this run did not discover. */
  | 'merge'
  /** A reset: the user is discarding stored choices, so preserve nothing. */
  | 'replace';

function partitionToolStates(states: ReadonlyMap<string, boolean>): {
  disabledTools: string[];
  enabledTools: string[];
} {
  const enabledTools: string[] = [];
  const disabledTools: string[] = [];
  for (const [id, enabled] of states) {
    (enabled ? enabledTools : disabledTools).push(id);
  }
  return { disabledTools, enabledTools };
}

/**
 * The stored states a `merge` write overlays onto, or a throw if the file
 * cannot be read.
 *
 * Refusing here is BST-1615's rule applied to the merge: a merge into a file we
 * could not read degrades into exactly the whole-file replace BST-1623 fixes,
 * over the user's only copy. This is NOT the latched session fault
 * `requireToolPreferencesWritable` covers — the projection pass can have read
 * the file cleanly and the file broken afterwards — so it is read fresh.
 */
async function readMergeBaseStates(userDataDir: string): Promise<Map<string, boolean>> {
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
      `MCP tool preferences could not be read from ${stored.path} — ${cause} (${stored.reason}). Your tool change was not saved; the file is left untouched so your saved choices can be recovered. Reset tool preferences to discard the broken file, or repair or remove it and choose Reload tool preferences in Settings.`
    );
  }

  return stored.status === 'loaded' ? readStoredToolStates(stored.preferences) : new Map();
}

/**
 * Apply a tool-preference mutation to the registry and persist the result.
 *
 * `merge` (a toggle) MERGES rather than replaces (BST-1623). `getAllTools()`
 * holds only the tools discovered on *this* run, so serialising it as the whole
 * file dropped the saved choices of every server whose discovery failed — one
 * toggle wiped a slow or erroring server's preferences, the same
 * absence-vs-failure conflation BST-1621 fixed in the load path. Every stored
 * id is carried through untouched, including ones this run never discovered.
 *
 * This function retires nothing, and holds no notion of what "retired" means —
 * its only contribution is declining to drop what it did not see. Retirement
 * is the projection path's job (`loadToolPreferencesForProjection`), which
 * BST-1621 re-keys onto a server's removal from the MCP config rather than its
 * absence from a discovery pass. Do not add a second retirement rule here:
 * that split is what keeps the two write paths from drifting.
 *
 * `replace` (a reset) preserves nothing by definition, so it never reads the
 * file and is never refused. Reset deliberately discards saved choices;
 * read-only reload is the separate in-session recovery for a repaired file.
 *
 * The read happens BEFORE `mutation()` so a refused write cannot leave the live
 * registry changed. `filterEnabledServerTools` consults that registry for
 * assistant runs, so mutating it behind a rejected IPC would be BST-1615's
 * "the UI says it worked" defect one layer up. It also restores the property
 * the pre-merge code had for free: with no `await` between `mutation()` and the
 * registry snapshot, the states written are exactly the ones that existed when
 * the mutation ran, so a concurrent re-discovery cannot be folded into it.
 *
 * Throws on failure (BST-1615). The caller is a user-initiated settings write:
 * swallowing the error made the IPC resolve successfully while nothing reached
 * disk, so the toggle silently reverted on the next launch.
 */
export async function applyToolPreferenceMutation(
  mutation: () => void,
  intent: ToolPreferenceWriteIntent
): Promise<void> {
  const userDataDir = app.getPath('userData');

  await withToolPreferencesFileLock(async () => {
    const states = intent === 'merge' ? await readMergeBaseStates(userDataDir) : new Map();

    // No `await` between the mutation and the snapshot: see above.
    mutation();
    for (const tool of getFlattenedTools()) {
      states.set(tool.id, tool.enabled);
    }

    try {
      await saveToolPreferences(userDataDir, {
        ...partitionToolStates(states),
        lastUpdated: Date.now(),
        version: TOOL_PREFERENCES_VERSION,
      });
    } catch (error) {
      logger.error('Failed to save tool preferences', { error });
      throw error;
    }
  });
}

/**
 * Every configured server that could own `toolId`.
 *
 * A tool id is `${server.name}.${tool.name}` and BOTH halves may contain dots,
 * so ownership is not decidable from the id alone: `foo.bar.write` is either
 * server `foo` with tool `bar.write` or server `foo.bar` with tool `write`.
 * This returns the candidates rather than guessing between them, so the caller
 * can see the difference between "one configured server owns this", "several
 * might" and "none can".
 */
function findOwningServerCandidates(
  toolId: string,
  configuredServerNames: ReadonlySet<string>
): string[] {
  const candidates: string[] = [];
  for (const serverName of configuredServerNames) {
    if (toolId.startsWith(`${serverName}.`)) {
      candidates.push(serverName);
    }
  }
  return candidates;
}

/**
 * True when `toolId` must survive this pass.
 *
 * Two independent reasons, and either is sufficient:
 *
 * 1. It is live in the registry right now. An id we can see this run is not
 *    retired, whatever the config says about prefixes. Without this the write
 *    could erase a preference the same pass just applied, and
 *    `ToolRegistry.register` would hand the tool back enabled next run — the
 *    exact failure this function exists to prevent. It also makes the retained
 *    set a superset of the applied set by construction, rather than by the
 *    coincidence that tool ids are built from `config.servers[].name`.
 * 2. Some configured server could own it. Where ownership is ambiguous (several
 *    candidates, thanks to dots on both sides) we retain: retiring on an
 *    ownership we cannot establish is data loss, and over-retaining costs a few
 *    stale strings. Only an id no configured server can claim is retired.
 */
function isRetainedPreferenceId(
  toolId: string,
  registeredIds: ReadonlySet<string>,
  configuredServerNames: ReadonlySet<string>
): boolean {
  if (registeredIds.has(toolId)) {
    return true;
  }
  return findOwningServerCandidates(toolId, configuredServerNames).length > 0;
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

/** Read-only recovery: no retirement, rewrite, timestamp update or file creation. */
export async function loadToolPreferencesForRecovery(): Promise<ToolPreferenceProjection> {
  const result = await loadToolPreferences(app.getPath('userData'));
  if (result.status === 'invalid' || result.status === 'unreadable') {
    return { kind: result.status, path: result.path, reason: result.reason, status: 'unavailable' };
  }
  if (result.status === 'absent') {
    return { disabledTools: [], enabledTools: [], status: 'available' };
  }
  const { disabledTools, enabledTools } = result.preferences;
  const disabled = new Set(disabledTools);
  return {
    disabledTools,
    enabledTools: enabledTools.filter((id) => !disabled.has(id)),
    status: 'available',
  };
}

/**
 * Projects saved tool preferences onto the tools discovered this run.
 *
 * Three rules, in precedence order:
 *
 * 1. A file we could not read is settled first (BST-1615): return
 *    `unavailable` and write nothing at all. The retirement question below
 *    never arises over a file whose contents we do not know.
 * 2. What we *apply* is scoped to `registeredIds`, because a preference can
 *    only be projected onto a tool that exists in the registry right now.
 * 3. What we *keep on disk* is scoped to `configuredServerNames` (BST-1621). A
 *    server that timed out, failed `tools/list`, or is still spawning under
 *    `npx` is absent from `registeredIds` through no fault of the user, and
 *    BST-1603 measured that happening routinely. Pruning on that signal
 *    silently deleted the user's choices and handed the tools back enabled on
 *    the next successful run, since `ToolRegistry.register` treats an unseen
 *    tool as enabled. Only removal from the MCP config retires an id; with no
 *    configured servers we have no authority to retire anything.
 */
export async function loadToolPreferencesForProjection(
  registeredIds: ReadonlySet<string>,
  configuredServerNames: ReadonlySet<string>
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
  const projection: ToolPreferenceProjection = {
    disabledTools: preferences.disabledTools.filter((id: string) => registeredIds.has(id)),
    enabledTools: preferences.enabledTools.filter((id: string) => registeredIds.has(id)),
    status: 'available',
  };

  if (configuredServerNames.size === 0) {
    return projection;
  }

  const isRetained = (id: string): boolean =>
    isRetainedPreferenceId(id, registeredIds, configuredServerNames);
  const keptEnabled = preferences.enabledTools.filter(isRetained);
  const keptDisabled = preferences.disabledTools.filter(isRetained);
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
      await saveToolPreferences(userDataDir, {
        disabledTools: keptDisabled,
        enabledTools: keptEnabled,
        lastUpdated: Date.now(),
        version: preferences.version,
      });
    } catch (saveError) {
      // Best-effort housekeeping over an already-readable file: the projection
      // is still exactly what the user chose, so a failed rewrite only means
      // the retired ids survive to the next load.
      logger.warn('Failed to persist cleaned tool preferences', { error: saveError });
    }
  }

  return projection;
}
