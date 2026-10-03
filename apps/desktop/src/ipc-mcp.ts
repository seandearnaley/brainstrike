import fsp from 'node:fs/promises';
import path from 'node:path';
import { mcpToolRegistry } from '@brainstrike/agent';
import {
  MCP_EXTENSIONS_ENABLED,
  type McpExtensionEnablement,
  type McpHostSnapshot,
  type McpToolPreferencesFault,
  type McpToolPreferencesFaultKind,
  parseMcpExtensionEnablement,
  parseMcpHostControlRequest,
} from '@brainstrike/assistant-contract';
import { isPathInsideRoot } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/logging';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import {
  type McpConfigStatus,
  mcpContract,
  mcpPathSelectionContract,
} from './ipc-domains/mcp.contract';
import { attachMcpBridges, type McpBridgesRuntime } from './mcp/bridges';
import { registerMcpContentIpc } from './mcp/content-ipc';
import {
  clearStoredMcpExtensionPreferences,
  type McpExtensionPreferencesStoreAccess,
  readStoredMcpExtensionPreferences,
  writeStoredMcpExtensionPreferences,
} from './mcp/extension-preferences';
import { type DesktopMcpHostRuntime, getDesktopMcpHostRuntime } from './mcp/host-runtime';
import { controlDestructiveMcpLifecycle, notifyMcpStatusUpdated } from './mcp/lifecycle-control';
import {
  applyToolPreferenceMutation,
  type DiscoveredServerTools,
  discoverToolsFromConfig,
  loadToolPreferencesForProjection,
  loadToolPreferencesForRecovery,
  type ToolPreferenceProjection,
  type ToolPreferenceWriteIntent,
  withToolPreferencesFileLock,
} from './mcp/tool-discovery';
import type { McpDiscoveredTool } from './mcp/types';
import {
  getDefaultMcpConfigTemplate,
  getMcpConfigPath,
  type LoadedMcpConfig,
  loadMcpConfig,
  readMcpConfigText,
  setCustomMcpConfigPath,
  watchMcpConfig,
  writeMcpConfigText,
} from './mcp-loader';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';
import type { Handlers } from './platform/ipc-contract';

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
let projectedAuthorityEpoch = 0;
let lastToolDiscoveries: DiscoveredServerTools[] = [];
let lastCommittedResolvedConfig: NonNullable<LoadedMcpConfig['config']> = { servers: [] };
interface McpFactoryResetSnapshot {
  readonly authorityConfig: NonNullable<LoadedMcpConfig['config']>;
  readonly config: LoadedMcpConfig | null;
  readonly discoveries: DiscoveredServerTools[];
  readonly extensionPreferences: McpExtensionEnablement;
  readonly selectedConfigPath: string | null;
  readonly toolPreferencesFault: McpToolPreferencesFault | null;
  readonly tools: ReturnType<typeof mcpToolRegistry.getAllTools>;
}
let pendingFactoryResetSnapshot: McpFactoryResetSnapshot | null = null;
/**
 * Desktop settings store access for the global extension dials. Registration
 * supplies it; without one the dials stay at their shipped default and a write
 * fails loudly instead of pretending to persist.
 */
let settingsStoreAccess: McpExtensionPreferencesStoreAccess = () => null;

/** Unreadable preferences fail closed; only recovery or explicit reset reopens writes. */
let toolPreferencesFault: McpToolPreferencesFault | null = null;

function buildToolPreferencesFaultMessage(fault: {
  kind: McpToolPreferencesFaultKind;
  path: string;
  reason: string;
}): string {
  const cause = fault.kind === 'invalid' ? 'the file is corrupt' : 'the file could not be read';
  return `MCP tool preferences could not be loaded from ${fault.path} — ${cause} (${fault.reason}). Every MCP tool is disabled and tool changes cannot be saved, so your saved choices are left on disk untouched. Repair or remove that file, then choose Reload tool preferences in Settings. Reset tool preferences discards your saved choices.`;
}

function requireToolPreferencesWritable(): void {
  if (toolPreferencesFault) {
    throw new Error(toolPreferencesFault.message);
  }
}
const logger = createLogger('DesktopMcpIpc');
const MAX_MCP_CONFIG_TEXT_BYTES = 1_000_000;
const mcpContentLifecycle = { barrier: () => mcpLifecycleBarrier, isOpen: () => mcpLifecycleOpen };
export const MCP_TOOLS_UPDATED_EVENT = mcpContract.onToolsUpdated.channel;
export const MCP_CONFIG_UPDATED_EVENT = mcpContract.onConfigUpdated.channel;
export const MCP_STATUS_UPDATED_EVENT = mcpContract.onServerStatusUpdated.channel;
export const MCP_EXTENSIONS_UPDATED_EVENT = mcpContract.onExtensionPreferencesUpdated.channel;
type McpAuthorityRuntime = Pick<
  DesktopMcpHostRuntime,
  'host' | 'mcpExtensionPreferences' | 'replaceResolvedConfig' | 'setMcpExtensionPreferences'
>;
type McpIpcRuntime = McpAuthorityRuntime & McpBridgesRuntime;

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

function rebuildToolRegistry(
  discoveries: DiscoveredServerTools[],
  toolIds: ReadonlySet<string>,
  preferences: ToolPreferenceProjection
): void {
  mcpToolRegistry.clear();
  for (const discovery of discoveries) {
    mcpToolRegistry.register(
      discovery.server.name,
      discovery.tools,
      discovery.server.enabledTools ? { enabledTools: discovery.server.enabledTools } : undefined
    );
  }

  if (preferences.status === 'not-read') {
    // An unread file cannot clear the fault or reopen writes.
    return;
  }

  if (preferences.status === 'unavailable') {
    // Fail closed: unreadable choices must never grant back disabled tools.
    toolPreferencesFault = {
      kind: preferences.kind,
      message: buildToolPreferencesFaultMessage(preferences),
      path: preferences.path,
    };
    mcpToolRegistry.disableTools([...toolIds]);
    return;
  }

  toolPreferencesFault = null;
  // Apply valid preferences
  if (preferences.disabledTools.length > 0) {
    mcpToolRegistry.disableTools(preferences.disabledTools);
  }
  if (preferences.enabledTools.length > 0) {
    mcpToolRegistry.enableTools(preferences.enabledTools);
  }
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
  // Discovery failure never retires preferences; only config removal can.
  const configuredServerNames = new Set(config.servers.map((server) => server.name));
  await withToolPreferencesFileLock(async () => {
    if (!isCurrentMcpAuthority(authorityEpoch, lifecycleEpoch)) {
      return;
    }
    // Empty discovery has no retirement authority. Keep any existing fault.
    const preferences: ToolPreferenceProjection =
      toolIds.size > 0
        ? await loadToolPreferencesForProjection(toolIds, configuredServerNames)
        : { status: 'not-read' };
    if (!isCurrentMcpAuthority(authorityEpoch, lifecycleEpoch)) {
      return;
    }
    // Keep file read, registry publication and notification in the same lock.
    rebuildToolRegistry(discoveries, toolIds, preferences);
    lastToolDiscoveries = discoveries;
    projectedAuthorityEpoch = authorityEpoch;
    notifyMcpToolsUpdated();
  });
}

function isCurrentMcpAuthority(authorityEpoch: number, lifecycleEpoch: number): boolean {
  return (
    mcpLifecycleOpen &&
    lifecycleEpoch === mcpLifecycleEpoch &&
    authorityEpoch === latestAuthorityEpoch
  );
}

async function reloadToolPreferences(): Promise<void> {
  await trackConfigOperation(async (lifecycleEpoch) => {
    // Earlier queued config work has settled; fence changes after recovery starts.
    const authorityEpoch = latestAuthorityEpoch;
    await withToolPreferencesFileLock(async () => {
      const assertCurrent = (): void => {
        if (!isCurrentMcpAuthority(authorityEpoch, lifecycleEpoch)) {
          throw new Error(
            'MCP tool registry changed or retired during preference reload. Retry Reload tool preferences.'
          );
        }
        if (projectedAuthorityEpoch !== authorityEpoch) {
          throw new Error(
            'MCP tools are not synchronized with their configuration. Save a valid MCP configuration or re-select its file in Settings before reloading tool preferences.'
          );
        }
      };
      assertCurrent();
      const preferences = await loadToolPreferencesForRecovery();
      assertCurrent();
      const toolIds = new Set(lastToolDiscoveries.flatMap(({ tools }) => Object.keys(tools)));
      // Re-register from discovery/config defaults, never the fail-closed registry.
      rebuildToolRegistry(lastToolDiscoveries, toolIds, preferences);
      notifyMcpToolsUpdated();
      requireToolPreferencesWritable();
    });
  });
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

function notifyMcpExtensionPreferences(preferences: McpExtensionEnablement): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(MCP_EXTENSIONS_UPDATED_EVENT, preferences);
  }
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
  toolPreferencesFault = null;
  lastToolDiscoveries = [];
  projectedAuthorityEpoch = latestAuthorityEpoch;
  mcpToolRegistry.clear();
}

function captureMcpFactoryResetSnapshot(runtime: McpAuthorityRuntime): McpFactoryResetSnapshot {
  return {
    authorityConfig: structuredClone(lastCommittedResolvedConfig),
    config: last === null ? null : structuredClone(last),
    // Host results passed assertStrictJson and SDK schema parsing before discovery.
    discoveries: structuredClone(lastToolDiscoveries),
    extensionPreferences: { ...runtime.mcpExtensionPreferences },
    selectedConfigPath: lastUserSelectedConfigPath,
    // Restored with the rest of the projection: an abandoned reset must not
    // leave writes unblocked while the preferences file is still unreadable.
    toolPreferencesFault,
    tools: getSerializableTools(),
  };
}

async function restoreMcpFactoryResetSnapshot(
  runtime: McpAuthorityRuntime,
  snapshot: McpFactoryResetSnapshot
): Promise<void> {
  await runtime.setMcpExtensionPreferences(snapshot.extensionPreferences);
  await runtime.replaceResolvedConfig(snapshot.authorityConfig);
  lastCommittedResolvedConfig = structuredClone(snapshot.authorityConfig);
  last = snapshot.config;
  lastUserSelectedConfigPath = snapshot.selectedConfigPath;
  toolPreferencesFault = snapshot.toolPreferencesFault;
  lastToolDiscoveries = snapshot.discoveries;
  projectedAuthorityEpoch = latestAuthorityEpoch;
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
  pendingFactoryResetSnapshot ??= captureMcpFactoryResetSnapshot(runtime);
  try {
    await runtime.replaceResolvedConfig({ servers: [] });
    lastCommittedResolvedConfig = { servers: [] };
    // The stored opt-out is desktop settings state: a reset returns the dials
    // to the shipped default, and the in-memory runtime value with them.
    clearStoredMcpExtensionPreferences(settingsStoreAccess);
    await runtime.setMcpExtensionPreferences(MCP_EXTENSIONS_ENABLED);
    notifyMcpExtensionPreferences(MCP_EXTENSIONS_ENABLED);
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

export function registerMcpIpcHandlers({
  runtime,
  settingsStore,
}: {
  runtime: McpIpcRuntime;
  /** Desktop settings store access; omitted only by harnesses without one. */
  settingsStore?: McpExtensionPreferencesStoreAccess;
}): () => void {
  logger.debug('Registering MCP IPC handlers');
  settingsStoreAccess = settingsStore ?? (() => null);
  const registry = createDesktopIpcRegistry({ ipcMain });
  // Handlers close over the registration-lifetime runtime and are accumulated
  // before the pure contract registers them atomically. `registerDomain`
  // validates completeness before touching Electron's registry.
  const mcpHandlers: Partial<Handlers<typeof mcpContract>> = {};
  const defineMcpHandler = <K extends keyof Handlers<typeof mcpContract>>(
    key: K,
    handler: Handlers<typeof mcpContract>[K]
  ): void => {
    if (key in mcpHandlers) {
      throw new Error(`Duplicate MCP handler definition: ${String(key)}`);
    }
    Object.assign(mcpHandlers, { [key]: handler });
  };
  const detachBridges = attachMcpBridges(runtime, registry);
  const stopStatusWatch = runtime.host.watch({}, notifyMcpStatusUpdated);
  const updateToolPreferences = async (
    mutation: () => void,
    intent: ToolPreferenceWriteIntent = 'merge'
  ): Promise<void> => {
    const expectedAuthorityEpoch = latestAuthorityEpoch;
    // A `replace` is a reset: the user is discarding stored choices, so there
    // is nothing to protect and the latched fault must NOT gate it.
    if (intent === 'merge') {
      // Refuse before mutating: writing now would flush the fail-closed registry
      // over the user's only (unreadable) copy of their preferences.
      requireToolPreferencesWritable();
    }
    await trackConfigOperation(async () => {
      if (expectedAuthorityEpoch !== latestAuthorityEpoch) {
        throw new Error('MCP tool registry changed before the deferred mutation executed');
      }
      if (intent === 'merge') {
        requireToolPreferencesWritable();
      }
      // Read before mutation; persist before reporting success to the renderer.
      await applyToolPreferenceMutation(mutation, intent);
      if (intent === 'replace') {
        // Explicit reset wrote a readable file and deliberately discarded saved choices.
        toolPreferencesFault = null;
      }
      notifyMcpToolsUpdated();
    });
  };

  defineMcpHandler(
    'getConfig',
    async (): Promise<McpConfigStatus> =>
      await trackConfigOperation(async () => {
        last = await loadMcpConfig();
        return toMcpConfigStatus(last);
      })
  );

  defineMcpHandler(
    'getServerStatusSnapshot',
    (): Promise<McpHostSnapshot> =>
      mcpLifecycleBarrier.then(() => structuredClone(runtime.host.snapshot()))
  );

  defineMcpHandler(
    'getExtensionPreferences',
    (): Promise<McpExtensionEnablement> =>
      mcpLifecycleBarrier.then(() => ({ ...runtime.mcpExtensionPreferences }))
  );

  defineMcpHandler('setExtensionPreferences', async (request): Promise<McpExtensionEnablement> => {
    const parsed = parseMcpExtensionEnablement(request);
    return await trackConfigOperation(async () => {
      // Persist FIRST: a rejected write must not leave the live host
      // advertising a state the next launch would not reproduce.
      const persisted = writeStoredMcpExtensionPreferences(settingsStoreAccess, parsed);
      await runtime.setMcpExtensionPreferences(persisted);
      notifyMcpExtensionPreferences(persisted);
      return persisted;
    });
  });

  defineMcpHandler('controlServer', async (request) => {
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
  });

  defineMcpHandler('getPath', async (): Promise<string> => await getMcpConfigPath());

  defineMcpHandler('setPath', (configPath): Promise<{ success: boolean; path: string }> => {
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
  });

  defineMcpHandler(
    'readConfigText',
    async (): Promise<{
      path: string;
      exists: boolean;
      created: boolean;
      content: string;
      error?: string;
    }> => await trackConfigOperation(async () => await readMcpConfigText(true))
  );

  defineMcpHandler(
    'writeConfigText',
    async (
      content
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

  registry.registerAuthorizedInvoke(
    'mcp',
    mcpPathSelectionContract.selectPath.channel,
    { roles: mcpPathSelectionContract.selectPath.roles },
    (event, ...raw): Promise<string | null> => {
      mcpPathSelectionContract.selectPath.parseArgs(raw);
      return selectMcpConfigPath(event.sender.id);
    }
  );

  defineMcpHandler('watch', async (): Promise<{ watching: boolean }> => {
    if (unwatch) {
      return { watching: true };
    }
    await restartConfigWatcher(runtime);
    return { watching: true };
  });

  defineMcpHandler('unwatch', async (): Promise<{ watching: false }> => {
    // Teardown remains meaningful after admission closes. Wait for every
    // operation and the serialized tail as they stood when unwatch was
    // invoked, then stop idempotently without entering the queue itself.
    const operationTail = mcpConfigOperationTail;
    const lifecycleBarrier = mcpLifecycleBarrier;
    await Promise.all([operationTail, lifecycleBarrier]);
    stopConfigWatcher();
    return { watching: false as const };
  });

  // Tool management IPC handlers
  defineMcpHandler(
    'listTools',
    async (): Promise<ReturnType<typeof mcpToolRegistry.getAllTools>> => getSerializableTools()
  );

  defineMcpHandler(
    'enableTools',
    async (toolIds): Promise<void> =>
      await updateToolPreferences(() => mcpToolRegistry.enableTools(toolIds))
  );

  defineMcpHandler(
    'disableTools',
    async (toolIds): Promise<void> =>
      await updateToolPreferences(() => mcpToolRegistry.disableTools(toolIds))
  );

  defineMcpHandler(
    'enableServerTools',
    async (serverName): Promise<void> =>
      await updateToolPreferences(() => mcpToolRegistry.enableServerTools(serverName))
  );

  defineMcpHandler(
    'disableServerTools',
    async (serverName): Promise<void> =>
      await updateToolPreferences(() => mcpToolRegistry.disableServerTools(serverName))
  );

  defineMcpHandler('reloadToolPreferences', reloadToolPreferences);
  defineMcpHandler(
    'resetTools',
    async (): Promise<void> => await updateToolPreferences(() => mcpToolRegistry.reset(), 'replace')
  );

  defineMcpHandler('getToolStats', async () => ({
    ...mcpToolRegistry.getStats(),
    ...(toolPreferencesFault ? { preferencesFault: toolPreferencesFault } : {}),
  }));

  defineMcpHandler(
    'createSampleConfig',
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

  registerDomain(registry, 'mcp', mcpContract, mcpHandlers as Handlers<typeof mcpContract>);
  registerMcpContentIpc(registry, runtime, mcpContentLifecycle);

  // Discover tools when config changes; saved preferences are applied after discovery completes
  const startup = trackConfigOperation(async (lifecycleEpoch) => {
    const stored = readStoredMcpExtensionPreferences(settingsStoreAccess);
    if (stored.state === 'unreadable') {
      // Fail closed: the stored value is the only record of a deliberate
      // opt-out, so an unreadable one advertises nothing until it is rewritten.
      logger.error('MCP extension preferences are unreadable; advertising no extensions', {
        error: stored.cause,
      });
    }
    await runtime.setMcpExtensionPreferences(stored.preferences);
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
    detachBridges();
    stopStatusWatch();
    registry.unregisterAll();
  };
}
