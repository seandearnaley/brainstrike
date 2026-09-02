import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  loadToolPreferences,
  mcpToolRegistry,
  saveToolPreferences,
  type ToolPreferences,
} from '@brainstrike/agent';
import {
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
  parseMcpHostControlRequest,
} from '@brainstrike/assistant-contract';
import { isPathInsideRoot } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/logging';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { registerMcpContentIpc } from './mcp/content-ipc';
import { attachMcpElicitationBridge } from './mcp/elicitation-bridge';
import { type DesktopMcpHostRuntime, getDesktopMcpHostRuntime } from './mcp/host-runtime';
import { controlDestructiveMcpLifecycle, notifyMcpStatusUpdated } from './mcp/lifecycle-control';
import type { McpDiscoveredTool } from './mcp/types';
import {
  getDefaultMcpConfigTemplate,
  getMcpConfigPath,
  type LoadedMcpConfig,
  loadMcpConfig,
  type McpServer,
  type ResolvedMcpServer,
  readMcpConfigText,
  setCustomMcpConfigPath,
  watchMcpConfig,
  writeMcpConfigText,
} from './mcp-loader';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

let unwatch: null | (() => void) = null;
let last: LoadedMcpConfig | null = null;
let lastUserSelectedConfigPath: string | null = null;
let latestConfigPathIntentEpoch = 0;
let pendingConfigPathSelection: {
  readonly selection: Promise<string | null>;
  readonly senderId: number;
} | null = null;
let mcpConfigOperationTail: Promise<void> = Promise.resolve();
let mcpLifecycleBarrier: Promise<void> = Promise.resolve();
let mcpLifecycleEpoch = 0;
let mcpLifecycleOpen = true;
let latestAuthorityEpoch = 0;
let latestLoadEpoch = 0;
let lastCommittedResolvedConfig: NonNullable<LoadedMcpConfig['config']> = { servers: [] };
interface McpFactoryResetSnapshot {
  readonly authorityConfig: NonNullable<LoadedMcpConfig['config']>;
  readonly config: LoadedMcpConfig | null;
  readonly selectedConfigPath: string | null;
  readonly tools: ReturnType<typeof mcpToolRegistry.getAllTools>;
}
let pendingFactoryResetSnapshot: McpFactoryResetSnapshot | null = null;
const logger = createLogger('DesktopMcpIpc');
const LEGACY_PLACEHOLDER_STDIO_ARG = 'path/to/your/mcp-server.js';
const LEGACY_PLACEHOLDER_SSE_URL = 'https://example.com/mcp/sse';
const MAX_MCP_CONFIG_TEXT_BYTES = 1_000_000;
const mcpContentLifecycle = { barrier: () => mcpLifecycleBarrier, isOpen: () => mcpLifecycleOpen };
export const MCP_TOOLS_UPDATED_EVENT = DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsUpdated;
export const MCP_CONFIG_UPDATED_EVENT = DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configUpdated;
export const MCP_STATUS_UPDATED_EVENT = DESKTOP_PRELOAD_IPC_CHANNELS.mcp.statusUpdated;
type McpAuthorityRuntime = Pick<DesktopMcpHostRuntime, 'host' | 'replaceResolvedConfig'>;
type McpIpcRuntime = McpAuthorityRuntime & Parameters<typeof attachMcpElicitationBridge>[0];

export interface McpConfigStatus {
  error?: string;
  exists: boolean;
  loadedAt?: number;
  migrations?: LoadedMcpConfig['migrations'];
  path: string;
  servers?: Array<{
    name: string;
    protocol: ResolvedMcpServer['protocol'];
    transport: ResolvedMcpServer['transport'];
  }>;
}

function toMcpConfigStatus(config: LoadedMcpConfig): McpConfigStatus {
  const status: McpConfigStatus = {
    exists: config.exists,
    path: config.path,
  };
  if (config.error !== undefined) {
    status.error = config.error;
  }
  if (config.loadedAt !== undefined) {
    status.loadedAt = config.loadedAt;
  }
  if (config.migrations && config.migrations.length > 0) {
    status.migrations = config.migrations;
  }
  const servers = config.servers ?? config.config?.servers;
  if (servers !== undefined) {
    status.servers = servers.map(({ name, protocol, transport }) => ({
      name,
      protocol,
      transport,
    }));
  }
  return status;
}

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

/**
 * Shared callback for both manual config changes and file watch events.
 */
async function applyConfigChange(
  runtime: McpAuthorityRuntime,
  cfg: LoadedMcpConfig,
  loadEpoch: number,
  lifecycleEpoch: number
): Promise<void> {
  if (!mcpLifecycleOpen || lifecycleEpoch !== mcpLifecycleEpoch || loadEpoch !== latestLoadEpoch) {
    return;
  }
  if (cfg.error) {
    last = cfg;
    notifyMcpConfigUpdated(cfg);
    logger.error('MCP config could not be loaded', {
      error: cfg.error,
      path: cfg.path,
    });
    return;
  }
  if (cfg.exists && !cfg.config) {
    throw new Error('Existing MCP config load result is missing resolved configuration');
  }

  const authorityEpoch = ++latestAuthorityEpoch;
  const config = cfg.config ?? { servers: [] };
  const committed = await runtime.replaceResolvedConfig(config);
  if (authorityEpoch === latestAuthorityEpoch) {
    lastCommittedResolvedConfig = structuredClone(config);
  }
  if (
    mcpLifecycleOpen &&
    lifecycleEpoch === mcpLifecycleEpoch &&
    loadEpoch === latestLoadEpoch &&
    authorityEpoch === latestAuthorityEpoch
  ) {
    last = cfg;
    notifyMcpConfigUpdated(cfg);
  }

  const discoveries = cfg.config
    ? await discoverToolsFromConfig(runtime, cfg.config, committed)
    : [];
  if (
    !mcpLifecycleOpen ||
    lifecycleEpoch !== mcpLifecycleEpoch ||
    authorityEpoch !== latestAuthorityEpoch
  ) {
    return;
  }
  const toolIds = new Set(discoveries.flatMap((discovery) => Object.keys(discovery.tools)));
  const preferences =
    toolIds.size > 0
      ? await loadToolPreferencesForProjection(toolIds)
      : { disabledTools: [], enabledTools: [] };
  if (
    !mcpLifecycleOpen ||
    lifecycleEpoch !== mcpLifecycleEpoch ||
    authorityEpoch !== latestAuthorityEpoch
  ) {
    return;
  }

  mcpToolRegistry.clear();
  for (const discovery of discoveries) {
    mcpToolRegistry.register(
      discovery.server.name,
      discovery.tools,
      discovery.server.enabledTools ? { enabledTools: discovery.server.enabledTools } : undefined
    );
  }
  // Apply valid preferences
  if (preferences.disabledTools.length > 0) {
    mcpToolRegistry.disableTools(preferences.disabledTools);
  }
  if (preferences.enabledTools.length > 0) {
    mcpToolRegistry.enableTools(preferences.enabledTools);
  }
  notifyMcpToolsUpdated();
}

function registerConfigChange<T>(pending: Promise<T>): Promise<T> {
  const settled = pending.then(
    () => undefined,
    () => undefined
  );
  mcpLifecycleBarrier = Promise.all([mcpLifecycleBarrier, settled]).then(() => undefined);
  return pending;
}

function trackConfigChange<T>(operation: (lifecycleEpoch: number) => Promise<T>): Promise<T> {
  if (!mcpLifecycleOpen) {
    return Promise.reject(new Error('MCP config lifecycle is closed for cleanup'));
  }
  return registerConfigChange(operation(mcpLifecycleEpoch));
}

function trackConfigOperation<T>(operation: (lifecycleEpoch: number) => Promise<T>): Promise<T> {
  if (!mcpLifecycleOpen) {
    return Promise.reject(new Error('MCP config lifecycle is closed for cleanup'));
  }
  // Non-reentrant by construction: code already inside a tracked operation
  // must call the *ForLifecycle helpers with its captured epoch. Re-entering
  // this queue from an operation would await its own unsettled tail forever.
  const lifecycleEpoch = mcpLifecycleEpoch;
  const pending = mcpConfigOperationTail.then(async () => {
    if (!mcpLifecycleOpen || lifecycleEpoch !== mcpLifecycleEpoch) {
      throw new Error('MCP config lifecycle operation was retired before execution');
    }
    return await operation(lifecycleEpoch);
  });
  mcpConfigOperationTail = pending.then(
    () => undefined,
    () => undefined
  );
  return registerConfigChange(pending);
}

function handleConfigChange(
  runtime: McpAuthorityRuntime,
  cfg: LoadedMcpConfig,
  sourceLifecycleEpoch = mcpLifecycleEpoch
): Promise<void> {
  if (!mcpLifecycleOpen || sourceLifecycleEpoch !== mcpLifecycleEpoch) {
    return Promise.resolve();
  }
  const loadEpoch = ++latestLoadEpoch;
  return trackConfigChange(async (lifecycleEpoch) =>
    applyConfigChange(runtime, cfg, loadEpoch, lifecycleEpoch)
  );
}

async function reloadMcpConfigForLifecycle(
  runtime: McpAuthorityRuntime,
  lifecycleEpoch: number
): Promise<void> {
  const loadEpoch = ++latestLoadEpoch;
  const config = await loadMcpConfig();
  await applyConfigChange(runtime, config, loadEpoch, lifecycleEpoch);
}

function notifyMcpConfigUpdated(config: LoadedMcpConfig): void {
  const payload = toMcpConfigStatus(config);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(MCP_CONFIG_UPDATED_EVENT, payload);
  }
}

function getSerializableTools(): ReturnType<typeof mcpToolRegistry.getAllTools> {
  // Metadata is plain JSON-shaped data (no functions). structuredClone matches Electron IPC
  // serialization and isolates the renderer payload from live registry mutations.
  return structuredClone(mcpToolRegistry.getAllTools());
}

function notifyMcpToolsUpdated(): void {
  const payload = getSerializableTools();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(MCP_TOOLS_UPDATED_EVENT, payload);
  }
}

function resolveAllowedMcpConfigPath(configPath: string | null): string | null {
  if (configPath === null) {
    return null;
  }
  const trimmedPath = configPath.trim();
  if (!(trimmedPath.length > 0 && path.isAbsolute(trimmedPath))) {
    throw new Error('MCP config path must be an absolute path selected by the user.');
  }

  const userData = app.getPath('userData');
  const mcpUserDataRoot = path.join(userData, 'mcp');
  const resolvedPath = path.resolve(trimmedPath);
  if (isPathInsideRoot(mcpUserDataRoot, resolvedPath)) {
    return resolvedPath;
  }
  if (lastUserSelectedConfigPath && resolvedPath === lastUserSelectedConfigPath) {
    return resolvedPath;
  }
  throw new Error('MCP config path must be selected with the native file picker.');
}

function clearPendingConfigPathSelection(selection: Promise<string | null>): void {
  if (pendingConfigPathSelection?.selection === selection) {
    pendingConfigPathSelection = null;
  }
}

function selectMcpConfigPath(senderId: number): Promise<string | null> {
  if (!mcpLifecycleOpen) {
    return Promise.reject(new Error('MCP config lifecycle is closed for cleanup'));
  }
  if (pendingConfigPathSelection !== null) {
    if (pendingConfigPathSelection.senderId !== senderId) {
      return Promise.reject(
        new Error('MCP config path selection is already active for another window')
      );
    }
    return pendingConfigPathSelection.selection;
  }

  const lifecycleEpoch = mcpLifecycleEpoch;
  const intentEpoch = ++latestConfigPathIntentEpoch;
  const selection = dialog
    .showOpenDialog({
      filters: [
        { extensions: ['json'], name: 'JSON Config' },
        { extensions: ['*'], name: 'All Files' },
      ],
      properties: ['openFile'],
      title: 'Select MCP Configuration File',
    })
    .then((result) => {
      if (!mcpLifecycleOpen || lifecycleEpoch !== mcpLifecycleEpoch) {
        throw new Error('MCP config path selection was retired before completion');
      }
      if (intentEpoch !== latestConfigPathIntentEpoch) {
        throw new Error('MCP config path selection was superseded before completion');
      }
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      const selectedPath = result.filePaths[0];
      if (!selectedPath) {
        return null;
      }
      lastUserSelectedConfigPath = path.resolve(selectedPath);
      return lastUserSelectedConfigPath;
    });
  pendingConfigPathSelection = { selection, senderId };
  void selection.then(
    () => clearPendingConfigPathSelection(selection),
    () => clearPendingConfigPathSelection(selection)
  );
  return selection;
}

async function restartConfigWatcher(runtime: McpAuthorityRuntime): Promise<void> {
  await trackConfigOperation(async (lifecycleEpoch) =>
    restartConfigWatcherForLifecycle(runtime, lifecycleEpoch)
  );
}

async function restartConfigWatcherForLifecycle(
  runtime: McpAuthorityRuntime,
  lifecycleEpoch: number
): Promise<void> {
  stopConfigWatcher();
  const watcher = await watchMcpConfig((config) =>
    handleConfigChange(runtime, config, lifecycleEpoch)
  );
  if (!mcpLifecycleOpen || lifecycleEpoch !== mcpLifecycleEpoch) {
    watcher.close();
    return;
  }
  unwatch = () => watcher.close();
}

function stopConfigWatcher(): void {
  const stop = unwatch;
  unwatch = null;
  if (stop) {
    stop();
  }
}

function beginMcpRuntimeCleanup(): { epoch: number; failures: unknown[] } {
  mcpLifecycleOpen = false;
  mcpLifecycleEpoch += 1;
  pendingConfigPathSelection = null;
  latestLoadEpoch += 1;
  latestAuthorityEpoch += 1;
  const failures: unknown[] = [];
  try {
    stopConfigWatcher();
  } catch (error) {
    failures.push(error);
  }
  return { epoch: mcpLifecycleEpoch, failures };
}

function purgeMcpRuntimeProjection(): void {
  last = null;
  lastUserSelectedConfigPath = null;
  mcpToolRegistry.clear();
}

function captureMcpFactoryResetSnapshot(): McpFactoryResetSnapshot {
  return {
    authorityConfig: structuredClone(lastCommittedResolvedConfig),
    config: last === null ? null : structuredClone(last),
    selectedConfigPath: lastUserSelectedConfigPath,
    tools: getSerializableTools(),
  };
}

async function restoreMcpFactoryResetSnapshot(
  runtime: McpAuthorityRuntime,
  snapshot: McpFactoryResetSnapshot
): Promise<void> {
  await runtime.replaceResolvedConfig(snapshot.authorityConfig);
  lastCommittedResolvedConfig = structuredClone(snapshot.authorityConfig);
  last = snapshot.config;
  lastUserSelectedConfigPath = snapshot.selectedConfigPath;
  mcpToolRegistry.clear();
  const disabledToolIds: string[] = [];
  for (const [serverName, tools] of Object.entries(snapshot.tools)) {
    const restoredTools: Record<string, McpDiscoveredTool> = {};
    for (const tool of tools) {
      restoredTools[tool.id] = {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
      };
      if (!tool.enabled) {
        disabledToolIds.push(tool.id);
      }
    }
    mcpToolRegistry.register(serverName, restoredTools);
  }
  if (disabledToolIds.length > 0) {
    mcpToolRegistry.disableTools(disabledToolIds);
  }
}

function throwMcpCleanupFailures(scope: 'reset' | 'shutdown', failures: unknown[]): void {
  if (failures.length > 0) {
    throw new AggregateError(failures, `MCP runtime ${scope} cleanup failed`);
  }
}

export async function cleanupMcpRuntimeForShutdown(
  runtime: McpAuthorityRuntime = getDesktopMcpHostRuntime()
): Promise<void> {
  const { failures } = beginMcpRuntimeCleanup();
  await mcpLifecycleBarrier;
  pendingFactoryResetSnapshot = null;
  purgeMcpRuntimeProjection();
  const [hostClose] = await Promise.allSettled([runtime.host.close()] as const);
  if (hostClose.status === 'rejected') {
    failures.push(hostClose.reason);
  } else {
    failures.push(...hostClose.value.failures);
  }
  throwMcpCleanupFailures('shutdown', failures);
  if (hostClose.status !== 'fulfilled') {
    throw new Error('MCP shutdown cleanup report is unavailable after successful cleanup');
  }
  logger.info('MCP runtime shutdown cleanup completed', {
    hostCloseReport: hostClose.value,
    legacyClientsClosed: true,
  });
}

export async function resetMcpRuntimeForFactoryReset(
  runtime: McpAuthorityRuntime = getDesktopMcpHostRuntime()
): Promise<void> {
  const { failures } = beginMcpRuntimeCleanup();
  await mcpLifecycleBarrier;
  // A retry can begin while a failed resume still owns the original snapshot.
  // Preserve that authority instead of replacing it with the already-purged state.
  pendingFactoryResetSnapshot ??= captureMcpFactoryResetSnapshot();
  try {
    await runtime.replaceResolvedConfig({ servers: [] });
    lastCommittedResolvedConfig = { servers: [] };
  } catch (error) {
    failures.push(error);
  }
  purgeMcpRuntimeProjection();
  throwMcpCleanupFailures('reset', failures);
}

export async function resumeMcpRuntimeAfterFactoryReset(
  runtime: McpAuthorityRuntime = getDesktopMcpHostRuntime(),
  outcome: 'failed' | 'succeeded' = 'succeeded'
): Promise<void> {
  if (mcpLifecycleOpen) {
    return;
  }
  const shouldRestore = outcome === 'failed';
  const lifecycleEpoch = mcpLifecycleEpoch;
  const snapshot = pendingFactoryResetSnapshot;
  let resumedWatcher: null | (() => void) = null;
  try {
    if (shouldRestore) {
      if (snapshot === null) {
        throw new Error('Cannot restore MCP runtime after failed reset without a prior snapshot');
      }
      await restoreMcpFactoryResetSnapshot(runtime, snapshot);
    }
    const watcher = await watchMcpConfig((config) =>
      handleConfigChange(runtime, config, lifecycleEpoch)
    );
    resumedWatcher = () => watcher.close();
    if (lifecycleEpoch !== mcpLifecycleEpoch) {
      throw new Error('MCP runtime resume was retired before admission reopened');
    }
    if (unwatch !== null) {
      throw new Error(
        'MCP runtime resume found an unretired config watcher; MCP config IPC remains closed until restart'
      );
    }
    unwatch = resumedWatcher;
    mcpLifecycleOpen = true;
    if (shouldRestore) {
      if (last !== null) {
        notifyMcpConfigUpdated(last);
      }
      notifyMcpToolsUpdated();
    }
    pendingFactoryResetSnapshot = null;
  } catch (error) {
    resumedWatcher?.();
    unwatch = null;
    mcpLifecycleOpen = false;
    throw error;
  }
}

export function registerMcpIpcHandlers({ runtime }: { runtime: McpIpcRuntime }): () => void {
  logger.debug('Registering MCP IPC handlers');
  const registry = createDesktopIpcRegistry({ ipcMain });
  const stopStatusWatch = runtime.host.watch({}, notifyMcpStatusUpdated);
  const detachElicitationBridge = attachMcpElicitationBridge(runtime, registry);
  const updateToolPreferences = async (mutation: () => void): Promise<void> => {
    const expectedAuthorityEpoch = latestAuthorityEpoch;
    await trackConfigOperation(async () => {
      if (expectedAuthorityEpoch !== latestAuthorityEpoch) {
        throw new Error('MCP tool registry changed before the deferred mutation executed');
      }
      mutation();
      notifyMcpToolsUpdated();
      await saveToolPreferencesIfNeeded();
    });
  };

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configGet,
    async (): Promise<McpConfigStatus> =>
      await trackConfigOperation(async () => {
        last = await loadMcpConfig();
        return toMcpConfigStatus(last);
      })
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.statusGet,
    (): Promise<McpHostSnapshot> =>
      mcpLifecycleBarrier.then(() => structuredClone(runtime.host.snapshot()))
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.lifecycleControl,
    async (_event, request: unknown) => {
      const parsed = parseMcpHostControlRequest(request);
      if (parsed.action === 'cancel') {
        return structuredClone(await runtime.host.control(parsed));
      }
      return await trackConfigOperation(async (lifecycleEpoch) => {
        if (parsed.action === 'disconnect' || parsed.action === 'reauthorize') {
          return structuredClone(
            await controlDestructiveMcpLifecycle(
              runtime.host,
              { action: parsed.action, configuredServerId: parsed.configuredServerId },
              async () => {
                await reloadMcpConfigForLifecycle(runtime, lifecycleEpoch);
              }
            )
          );
        }
        const result = await runtime.host.control(parsed);
        if (result.state === 'connected') {
          await reloadMcpConfigForLifecycle(runtime, lifecycleEpoch);
        }
        return structuredClone(result);
      });
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configGetPath,
    async (): Promise<string> => await getMcpConfigPath()
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configSetPath,
    (_e, configPath: string | null): Promise<{ success: boolean; path: string }> => {
      let resolvedConfigPath: string | null;
      try {
        resolvedConfigPath = resolveAllowedMcpConfigPath(configPath);
      } catch (error) {
        return Promise.reject(error);
      }
      latestConfigPathIntentEpoch += 1;
      return trackConfigOperation(async (lifecycleEpoch) => {
        await setCustomMcpConfigPath(resolvedConfigPath);
        const newPath = await getMcpConfigPath();

        logger.info('Loading config from new path', { path: newPath });
        await reloadMcpConfigForLifecycle(runtime, lifecycleEpoch);
        await restartConfigWatcherForLifecycle(runtime, lifecycleEpoch);

        return { path: newPath, success: true };
      });
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configReadText,
    async (): Promise<{
      path: string;
      exists: boolean;
      created: boolean;
      content: string;
    }> => await trackConfigOperation(async () => await readMcpConfigText(true))
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configWriteText,
    async (
      _e,
      content: unknown
    ): Promise<{ success: true; path: string } | { success: false; path: string; error: string }> =>
      await trackConfigOperation(async (lifecycleEpoch) => {
        const configPath = await getMcpConfigPath();

        if (typeof content !== 'string') {
          return {
            error: 'MCP config content must be a string',
            path: configPath,
            success: false as const,
          };
        }
        if (content.trim().length === 0) {
          return {
            error: 'MCP config content cannot be empty',
            path: configPath,
            success: false as const,
          };
        }

        const contentBytes = Buffer.byteLength(content, 'utf-8');
        if (contentBytes > MAX_MCP_CONFIG_TEXT_BYTES) {
          return {
            error: `MCP config exceeds ${MAX_MCP_CONFIG_TEXT_BYTES} bytes`,
            path: configPath,
            success: false as const,
          };
        }

        const restartWatcher = unwatch !== null;
        stopConfigWatcher();
        const result = await writeMcpConfigText(content);
        if (restartWatcher) {
          await restartConfigWatcherForLifecycle(runtime, lifecycleEpoch);
        }
        if (result.success) {
          logger.info('MCP config text updated', { path: result.path });
          await reloadMcpConfigForLifecycle(runtime, lifecycleEpoch);
        }
        return result;
      })
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configSelectPath,
    (event): Promise<string | null> => selectMcpConfigPath(event.sender.id)
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configWatch,
    async (_e): Promise<{ watching: boolean }> => {
      if (unwatch) {
        return { watching: true };
      }
      await restartConfigWatcher(runtime);
      return { watching: true };
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configUnwatch,
    async (): Promise<{ watching: false }> => {
      // Teardown remains meaningful after admission closes. Wait for every
      // operation and the serialized tail as they stood when unwatch was
      // invoked, then stop idempotently without entering the queue itself.
      const operationTail = mcpConfigOperationTail;
      const lifecycleBarrier = mcpLifecycleBarrier;
      await Promise.all([operationTail, lifecycleBarrier]);
      stopConfigWatcher();
      return { watching: false as const };
    }
  );

  // Tool management IPC handlers
  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsList,
    async (): Promise<ReturnType<typeof mcpToolRegistry.getAllTools>> => getSerializableTools()
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsEnable,
    async (_e, toolIds: string[]): Promise<void> =>
      await updateToolPreferences(() => mcpToolRegistry.enableTools(toolIds))
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsDisable,
    async (_e, toolIds: string[]): Promise<void> =>
      await updateToolPreferences(() => mcpToolRegistry.disableTools(toolIds))
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsEnableServer,
    async (_e, serverName: string): Promise<void> =>
      await updateToolPreferences(() => mcpToolRegistry.enableServerTools(serverName))
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsDisableServer,
    async (_e, serverName: string): Promise<void> =>
      await updateToolPreferences(() => mcpToolRegistry.disableServerTools(serverName))
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsReset,
    async (): Promise<void> => await updateToolPreferences(() => mcpToolRegistry.reset())
  );

  registry.registerInvoke('mcp', DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsGetStats, async () =>
    mcpToolRegistry.getStats()
  );

  registerMcpContentIpc(registry, runtime, mcpContentLifecycle);

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configCreateSample,
    async (): Promise<{ success: boolean; path: string; error?: string }> =>
      await trackConfigOperation(async (lifecycleEpoch) => {
        let configPath = '';
        try {
          configPath = await getMcpConfigPath();
          await fsp.mkdir(path.dirname(configPath), { recursive: true });

          // Write commented template without active placeholder servers.
          // Use exclusive create to avoid TOCTOU races with concurrent writers.
          try {
            await fsp.writeFile(configPath, getDefaultMcpConfigTemplate(), {
              encoding: 'utf-8',
              flag: 'wx',
            });
          } catch (error) {
            if ((error as { code?: unknown }).code === 'EEXIST') {
              const message =
                'MCP config already exists. Select the existing file or reset the path before creating a sample.';
              logger.warn('Refusing to overwrite existing MCP config', { path: configPath });
              return { error: message, path: configPath, success: false };
            }
            throw error;
          }
          logger.info('Created sample MCP config', { path: configPath });

          // Clear existing tools, reload config, and ensure file watcher tracks the new file.
          await reloadMcpConfigForLifecycle(runtime, lifecycleEpoch);
          await restartConfigWatcherForLifecycle(runtime, lifecycleEpoch);

          return { path: configPath, success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          logger.error('Failed to create sample MCP config', { error });
          return { error: message, path: configPath, success: false };
        }
      })
  );

  // Discover tools when config changes; saved preferences are applied after discovery completes
  const startup = trackConfigOperation(async (lifecycleEpoch) => {
    await restartConfigWatcherForLifecycle(runtime, lifecycleEpoch);
    await reloadMcpConfigForLifecycle(runtime, lifecycleEpoch);
  });
  const settledStartup = startup.then(
    () => undefined,
    () => undefined
  );
  mcpLifecycleBarrier = Promise.all([mcpLifecycleBarrier, settledStartup]).then(() => undefined);
  void startup.catch((error: unknown) => {
    logger.error('MCP runtime startup failed', { error });
  });

  return () => {
    detachElicitationBridge();
    stopStatusWatch();
    registry.unregisterAll();
  };
}

interface DiscoveredServerTools {
  server: ResolvedMcpServer;
  tools: Record<string, McpDiscoveredTool>;
}

async function discoverToolsFromConfig(
  runtime: McpAuthorityRuntime,
  config: NonNullable<LoadedMcpConfig['config']>,
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

async function saveToolPreferencesIfNeeded(): Promise<void> {
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

async function loadToolPreferencesForProjection(
  registeredIds: ReadonlySet<string>
): Promise<Pick<ToolPreferences, 'disabledTools' | 'enabledTools'>> {
  try {
    const preferences = await loadToolPreferences(app.getPath('userData'));
    if (!preferences) {
      return { disabledTools: [], enabledTools: [] };
    }

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
        await saveToolPreferences(app.getPath('userData'), {
          disabledTools: validDisabled,
          enabledTools: validEnabled,
          lastUpdated: Date.now(),
          version: preferences.version,
        });
      } catch (saveError) {
        logger.warn('Failed to persist cleaned tool preferences', { error: saveError });
      }
    }

    return { disabledTools: validDisabled, enabledTools: validEnabled };
  } catch (error) {
    logger.error('Failed to load tool preferences', { error });
    return { disabledTools: [], enabledTools: [] };
  }
}
