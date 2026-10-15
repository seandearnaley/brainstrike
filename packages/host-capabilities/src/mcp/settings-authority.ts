import path from 'node:path';
// The registry host runs filter tools through (`collectCombinedTools`).
import { mcpToolRegistry } from '@brainstrike/agent/mcp-client';
import type { HostMcpSettingsService, HostParams, HostResults } from '@brainstrike/agent-host';
import type { McpSettingsEvent, McpToolsByServer } from '@brainstrike/agent-host/protocol';
import {
  BoundaryFailureError,
  MCP_EXTENSIONS_ENABLED,
  type McpExtensionEnablement,
  type McpHostControlRequest,
  type McpHostPort,
  type McpHostServerSnapshot,
  type McpHostSnapshot,
  type McpToolPreferencesFault,
  type McpToolPreferencesFaultKind,
  parseMcpExtensionEnablement,
  refusal,
} from '@brainstrike/assistant-contract';
import { isPathInsideRoot } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/logging';
import type { LoadedMcpConfig, McpConfigFile, ResolvedMcpConfig } from './config-file.js';
import { toMcpConfigStatus } from './config-status.js';
import {
  clearStoredMcpExtensionPreferences,
  type McpExtensionPreferencesStore,
  readStoredMcpExtensionPreferences,
  writeStoredMcpExtensionPreferences,
} from './extension-preferences.js';
import {
  applyToolPreferenceMutation,
  type DiscoveredServerTools,
  discoverToolsFromConfig,
  loadToolPreferencesForProjection,
  loadToolPreferencesForRecovery,
  type ToolPreferenceProjection,
  type ToolPreferenceWriteIntent,
  withToolPreferencesFileLock,
} from './tool-discovery.js';
import type { McpDiscoveredTool } from './types.js';

const logger = createLogger('McpSettingsAuthority');
const MAX_MCP_CONFIG_TEXT_BYTES = 1_000_000;
/** A reset or shutdown retired the settings lifecycle: requests are refused, not failed. */
const MCP_SETTINGS_CLOSED = refusal({
  category: 'availability',
  code: 'mcp.settings-closed',
  message: 'MCP settings lifecycle is closed for cleanup',
});

/** The in-process MCP runtime the settings commit to. */
export interface McpSettingsRuntime {
  readonly host: Pick<McpHostPort, 'control' | 'invoke' | 'snapshot' | 'watch'>;
  readonly mcpExtensionPreferences: McpExtensionEnablement;
  replaceResolvedConfig(config: ResolvedMcpConfig): Promise<McpHostSnapshot>;
  setMcpExtensionPreferences(preferences: McpExtensionEnablement): Promise<McpHostSnapshot>;
}

export interface McpSettingsAuthorityOptions {
  readonly configFile: McpConfigFile;
  /** The host's StateStore settings, holding the global extension dials. */
  readonly extensionStore: McpExtensionPreferencesStore;
  readonly runtime: McpSettingsRuntime;
  /** The profile directory: `mcp/` holds the default config and the tool preferences. */
  readonly userDataDir: string;
}

interface McpFactoryResetSnapshot {
  readonly authorityConfig: ResolvedMcpConfig;
  readonly config: LoadedMcpConfig | null;
  readonly discoveries: DiscoveredServerTools[];
  readonly extensionPreferences: McpExtensionEnablement;
  readonly selectedConfigPath: string | null;
  readonly toolPreferencesFault: McpToolPreferencesFault | null;
  readonly tools: McpToolsByServer;
}

function buildToolPreferencesFaultMessage(fault: {
  kind: McpToolPreferencesFaultKind;
  path: string;
  reason: string;
}): string {
  const cause = fault.kind === 'invalid' ? 'the file is corrupt' : 'the file could not be read';
  return `MCP tool preferences could not be loaded from ${fault.path} — ${cause} (${fault.reason}). Every MCP tool is disabled and tool changes cannot be saved, so your saved choices are left on disk untouched. Repair or remove that file, then choose Reload tool preferences in Settings. Reset tool preferences discards your saved choices.`;
}

function serializableTools(): McpToolsByServer {
  // Metadata is plain JSON-shaped data; the clone isolates clients from live registry changes.
  return structuredClone(mcpToolRegistry.getAllTools()) as McpToolsByServer;
}

/**
 * The desktop profile's MCP settings authority (BST-1930 c5a): the config file
 * and its watcher, the global extension dials, tool discovery, the registry and
 * the saved tool preferences. The single writer of each; clients change them
 * only through its methods and hear each change through its subscribers.
 *
 * Every config change runs on one lifecycle: `trackOperation` serializes
 * client-initiated changes, `trackChange` records watcher changes on the
 * barrier, and the epochs retire work a later change or a reset superseded.
 */
export class McpSettingsAuthority implements HostMcpSettingsService {
  #unwatch: null | (() => void) = null;
  #last: LoadedMcpConfig | null = null;
  #lastUserSelectedConfigPath: string | null = null;
  #operationTail: Promise<void> = Promise.resolve();
  #barrier: Promise<void> = Promise.resolve();
  #lifecycleEpoch = 0;
  #lifecycleOpen = true;
  #latestAuthorityEpoch = 0;
  #latestLoadEpoch = 0;
  #projectedAuthorityEpoch = 0;
  #lastToolDiscoveries: DiscoveredServerTools[] = [];
  #lastCommittedResolvedConfig: ResolvedMcpConfig = { servers: [] };
  #pendingFactoryResetSnapshot: McpFactoryResetSnapshot | null = null;
  /** Unreadable preferences fail closed; only recovery or explicit reset reopens writes. */
  #toolPreferencesFault: McpToolPreferencesFault | null = null;
  readonly #listeners = new Set<(event: McpSettingsEvent) => void>();
  /** The runtime's status watch, held while any subscriber listens. */
  #unwatchStatus: null | (() => void) = null;

  constructor(private readonly options: McpSettingsAuthorityOptions) {}

  /** Apply the stored extension dials, start the watcher, and load and discover the config. */
  start(): Promise<void> {
    const startup = this.#trackOperation(async (lifecycleEpoch) => {
      const stored = await readStoredMcpExtensionPreferences(this.options.extensionStore);
      if (stored.state === 'unreadable') {
        // Fail closed: the stored value is the only record of a deliberate
        // opt-out, so an unreadable one advertises nothing until it is rewritten.
        logger.error('MCP extension preferences are unreadable; advertising no extensions', {
          error: stored.cause,
        });
      }
      await this.options.runtime.setMcpExtensionPreferences(stored.preferences);
      await this.#restartWatcherForLifecycle(lifecycleEpoch);
      await this.#reloadForLifecycle(lifecycleEpoch);
    });
    return startup;
  }

  subscribe(listener: (event: McpSettingsEvent) => void): () => void {
    this.#listeners.add(listener);
    this.#unwatchStatus ??= this.options.runtime.host.watch({}, (status) =>
      this.#emit({ status, type: 'status' })
    );
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopStatusWatch();
      }
    };
  }

  async snapshot(): Promise<HostResults['mcp/settings/subscribe']> {
    const config = await this.configStatus();
    return {
      config,
      extensions: { ...this.options.runtime.mcpExtensionPreferences },
      status: this.status(),
      tools: serializableTools(),
    };
  }

  /** The runtime's server status, at its current revision. */
  status(): McpHostSnapshot {
    return this.options.runtime.host.snapshot();
  }

  /**
   * Whether a content read may run (BST-1930 c5d): it waits out the config
   * change in flight, never queues behind config operations, and is refused
   * while a factory reset or shutdown holds the lifecycle.
   */
  async admitContent(): Promise<boolean> {
    await this.#barrier;
    return this.#lifecycleOpen;
  }

  configStatus(): Promise<HostResults['mcp/config/status']> {
    return this.#trackOperation(async () => {
      this.#last = await this.options.configFile.load();
      return toMcpConfigStatus(this.#last);
    });
  }

  async configPath(): Promise<HostResults['mcp/config/path']> {
    return { path: await this.options.configFile.path() };
  }

  setConfigPath(
    request: HostParams<'mcp/config/path/set'>
  ): Promise<HostResults['mcp/config/path/set']> {
    let resolvedConfigPath: string | null;
    try {
      resolvedConfigPath = this.#resolveAllowedConfigPath(request.path);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#applyConfigPath(resolvedConfigPath);
  }

  /**
   * The desktop's native picker chose this file (Main's only MCP adapter): it
   * becomes the selected config, and a later `setConfigPath` may name it again.
   */
  pickConfigPath(selectedPath: string): Promise<HostResults['mcp/config/path/set']> {
    if (!path.isAbsolute(selectedPath)) {
      return Promise.reject(new Error('MCP config path must be an absolute path.'));
    }
    this.#lastUserSelectedConfigPath = path.resolve(selectedPath);
    return this.#applyConfigPath(this.#lastUserSelectedConfigPath);
  }

  readConfigText(): Promise<HostResults['mcp/config/read']> {
    return this.#trackOperation(async () => await this.options.configFile.readText(true));
  }

  writeConfigText({
    content,
  }: HostParams<'mcp/config/write'>): Promise<HostResults['mcp/config/write']> {
    return this.#trackOperation(async (lifecycleEpoch) => {
      const configPath = await this.options.configFile.path();
      if (content.trim().length === 0) {
        return { error: 'MCP config content cannot be empty', path: configPath, success: false };
      }
      if (Buffer.byteLength(content, 'utf-8') > MAX_MCP_CONFIG_TEXT_BYTES) {
        return {
          error: `MCP config exceeds ${MAX_MCP_CONFIG_TEXT_BYTES} bytes`,
          path: configPath,
          success: false,
        };
      }
      const restartWatcher = this.#unwatch !== null;
      this.#stopWatcher();
      const result = await this.options.configFile.writeText(content);
      if (restartWatcher) {
        await this.#restartWatcherForLifecycle(lifecycleEpoch);
      }
      if (result.success) {
        logger.info('MCP config text updated', { path: result.path });
        await this.#reloadForLifecycle(lifecycleEpoch);
      }
      return result;
    });
  }

  createSampleConfig(): Promise<HostResults['mcp/config/sample']> {
    return this.#trackOperation(async (lifecycleEpoch) => {
      let configPath = '';
      try {
        configPath = await this.options.configFile.path();
        const sample = await this.options.configFile.createSample();
        configPath = sample.path;
        if (!sample.created) {
          logger.warn('Refusing to overwrite existing MCP config', { path: configPath });
          return {
            error:
              'MCP config already exists. Select the existing file or reset the path before creating a sample.',
            path: configPath,
            success: false,
          };
        }
        logger.info('Created sample MCP config', { path: configPath });
        // Reload the empty sample and keep the watcher on the new file.
        await this.#reloadForLifecycle(lifecycleEpoch);
        await this.#restartWatcherForLifecycle(lifecycleEpoch);
        return { path: configPath, success: true };
      } catch (error) {
        logger.error('Failed to create sample MCP config', { error });
        return {
          error: error instanceof Error ? error.message : 'Unknown error',
          path: configPath,
          success: false,
        };
      }
    });
  }

  async extensions(): Promise<HostResults['mcp/extensions/read']> {
    await this.#barrier;
    return { ...this.options.runtime.mcpExtensionPreferences };
  }

  setExtensions(
    request: HostParams<'mcp/extensions/set'>
  ): Promise<HostResults['mcp/extensions/set']> {
    let parsed: McpExtensionEnablement;
    try {
      parsed = parseMcpExtensionEnablement(request);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#trackOperation(async () => {
      // Persist FIRST: a rejected write must not leave the live host
      // advertising a state the next launch would not reproduce.
      const persisted = await writeStoredMcpExtensionPreferences(
        this.options.extensionStore,
        parsed
      );
      await this.options.runtime.setMcpExtensionPreferences(persisted);
      this.#emit({ extensions: { ...persisted }, type: 'extensions' });
      return persisted;
    });
  }

  async tools(): Promise<HostResults['mcp/tools/list']> {
    return serializableTools();
  }

  async toolStats(): Promise<HostResults['mcp/tools/stats']> {
    return {
      ...mcpToolRegistry.getStats(),
      ...(this.#toolPreferencesFault ? { preferencesFault: this.#toolPreferencesFault } : {}),
    };
  }

  setToolsEnabled({ enabled, toolIds }: HostParams<'mcp/tools/set'>): Promise<void> {
    return this.#updateToolPreferences(() =>
      enabled ? mcpToolRegistry.enableTools(toolIds) : mcpToolRegistry.disableTools(toolIds)
    );
  }

  setServerToolsEnabled({
    enabled,
    serverName,
  }: HostParams<'mcp/tools/server/set'>): Promise<void> {
    return this.#updateToolPreferences(() =>
      enabled
        ? mcpToolRegistry.enableServerTools(serverName)
        : mcpToolRegistry.disableServerTools(serverName)
    );
  }

  resetTools(): Promise<void> {
    return this.#updateToolPreferences(() => mcpToolRegistry.reset(), 'replace');
  }

  reloadToolPreferences(): Promise<void> {
    return this.#trackOperation(async (lifecycleEpoch) => {
      // Earlier queued config work has settled; fence changes after recovery starts.
      const authorityEpoch = this.#latestAuthorityEpoch;
      await withToolPreferencesFileLock(async () => {
        const assertCurrent = (): void => {
          if (!this.#isCurrentAuthority(authorityEpoch, lifecycleEpoch)) {
            throw new Error(
              'MCP tool registry changed or retired during preference reload. Retry Reload tool preferences.'
            );
          }
          if (this.#projectedAuthorityEpoch !== authorityEpoch) {
            throw new Error(
              'MCP tools are not synchronized with their configuration. Save a valid MCP configuration or re-select its file in Settings before reloading tool preferences.'
            );
          }
        };
        assertCurrent();
        const preferences = await loadToolPreferencesForRecovery(this.options.userDataDir);
        assertCurrent();
        const toolIds = new Set(
          this.#lastToolDiscoveries.flatMap(({ tools }) => Object.keys(tools))
        );
        // Re-register from discovery/config defaults, never the fail-closed registry.
        this.#rebuildToolRegistry(this.#lastToolDiscoveries, toolIds, preferences);
        this.#emitTools();
        this.#requireToolPreferencesWritable();
      });
    });
  }

  /**
   * A lifecycle control, as Settings asks for it. A disconnect or reauthorize
   * reloads the config whatever its outcome; a connect that succeeds reloads it
   * so discovery reaches the newly connected server.
   */
  control(request: McpHostControlRequest): Promise<McpHostServerSnapshot> {
    const host = this.options.runtime.host;
    if (request.action === 'cancel') {
      return host.control(request);
    }
    return this.#trackOperation(async (lifecycleEpoch) => {
      if (request.action === 'disconnect' || request.action === 'reauthorize') {
        return await this.#controlDestructive(request, () =>
          this.#reloadForLifecycle(lifecycleEpoch)
        );
      }
      const result = await host.control(request);
      if (result.state === 'connected') {
        await this.#reloadForLifecycle(lifecycleEpoch);
      }
      return result;
    });
  }

  /** Factory reset: retire the lifecycle, empty the runtime and dials, and keep a restore point. */
  async reset(): Promise<void> {
    const failures = this.#beginCleanup();
    await this.#barrier;
    // A retry can begin while a failed resume still owns the original snapshot.
    // Preserve that authority instead of replacing it with the already-purged state.
    this.#pendingFactoryResetSnapshot ??= this.#captureSnapshot();
    try {
      await this.options.runtime.replaceResolvedConfig({ servers: [] });
      this.#lastCommittedResolvedConfig = { servers: [] };
      // A reset returns the dials to the shipped default, and the runtime with them.
      await clearStoredMcpExtensionPreferences(this.options.extensionStore);
      await this.options.runtime.setMcpExtensionPreferences(MCP_EXTENSIONS_ENABLED);
      this.#emit({ extensions: { ...MCP_EXTENSIONS_ENABLED }, type: 'extensions' });
    } catch (error) {
      failures.push(error);
    }
    this.#purgeProjection();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'MCP settings reset cleanup failed');
    }
  }

  /** After a factory reset: reopen the lifecycle, restoring the snapshot when the reset failed. */
  async resume(outcome: 'failed' | 'succeeded'): Promise<void> {
    if (this.#lifecycleOpen) {
      return;
    }
    const shouldRestore = outcome === 'failed';
    const lifecycleEpoch = this.#lifecycleEpoch;
    const snapshot = this.#pendingFactoryResetSnapshot;
    let resumedWatcher: null | (() => void) = null;
    try {
      if (shouldRestore) {
        if (snapshot === null) {
          throw new Error('Cannot restore MCP settings after a failed reset without a snapshot');
        }
        await this.#restoreSnapshot(snapshot);
      }
      const watcher = await this.options.configFile.watch((config) =>
        this.#handleConfigChange(config, lifecycleEpoch)
      );
      resumedWatcher = () => watcher.close();
      if (lifecycleEpoch !== this.#lifecycleEpoch) {
        throw new Error('MCP settings resume was retired before admission reopened');
      }
      if (this.#unwatch !== null) {
        throw new Error(
          'MCP settings resume found an unretired config watcher; MCP settings remain closed until restart'
        );
      }
      this.#unwatch = resumedWatcher;
      this.#lifecycleOpen = true;
      if (shouldRestore) {
        if (this.#last !== null) {
          this.#emit({ config: toMcpConfigStatus(this.#last), type: 'config' });
        }
        this.#emitTools();
      }
      this.#pendingFactoryResetSnapshot = null;
    } catch (error) {
      resumedWatcher?.();
      this.#unwatch = null;
      this.#lifecycleOpen = false;
      throw error;
    }
  }

  /** Host shutdown: retire the lifecycle and join its work. The runtime closes with its owner. */
  async close(): Promise<void> {
    const failures = this.#beginCleanup();
    await this.#barrier;
    this.#pendingFactoryResetSnapshot = null;
    this.#purgeProjection();
    this.#listeners.clear();
    this.#stopStatusWatch();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'MCP settings shutdown cleanup failed');
    }
  }

  #stopStatusWatch(): void {
    this.#unwatchStatus?.();
    this.#unwatchStatus = null;
  }

  #emit(event: McpSettingsEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(structuredClone(event));
      } catch (error) {
        logger.error('MCP settings listener threw', { error });
      }
    }
  }

  #emitTools(): void {
    this.#emit({ tools: serializableTools(), type: 'tools' });
  }

  #requireToolPreferencesWritable(): void {
    if (this.#toolPreferencesFault) {
      throw new Error(this.#toolPreferencesFault.message);
    }
  }

  #updateToolPreferences(
    mutation: () => void,
    intent: ToolPreferenceWriteIntent = 'merge'
  ): Promise<void> {
    const expectedAuthorityEpoch = this.#latestAuthorityEpoch;
    // A `replace` is a reset: the user is discarding stored choices, so there
    // is nothing to protect and the latched fault must NOT gate it.
    if (intent === 'merge') {
      // Refuse before mutating: writing now would flush the fail-closed registry
      // over the user's only (unreadable) copy of their preferences.
      try {
        this.#requireToolPreferencesWritable();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return this.#trackOperation(async () => {
      if (expectedAuthorityEpoch !== this.#latestAuthorityEpoch) {
        throw new Error('MCP tool registry changed before the deferred mutation executed');
      }
      if (intent === 'merge') {
        this.#requireToolPreferencesWritable();
      }
      // Read before mutation; persist before reporting success.
      await applyToolPreferenceMutation(this.options.userDataDir, mutation, intent);
      if (intent === 'replace') {
        // Explicit reset wrote a readable file and deliberately discarded saved choices.
        this.#toolPreferencesFault = null;
      }
      this.#emitTools();
    });
  }

  #rebuildToolRegistry(
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
      this.#toolPreferencesFault = {
        kind: preferences.kind,
        message: buildToolPreferencesFaultMessage(preferences),
        path: preferences.path,
      };
      mcpToolRegistry.disableTools([...toolIds]);
      return;
    }
    this.#toolPreferencesFault = null;
    if (preferences.disabledTools.length > 0) {
      mcpToolRegistry.disableTools(preferences.disabledTools);
    }
    if (preferences.enabledTools.length > 0) {
      mcpToolRegistry.enableTools(preferences.enabledTools);
    }
  }

  /** Shared by client-initiated config changes and watcher events. */
  async #applyConfigChange(
    cfg: LoadedMcpConfig,
    loadEpoch: number,
    lifecycleEpoch: number
  ): Promise<void> {
    if (
      !this.#lifecycleOpen ||
      lifecycleEpoch !== this.#lifecycleEpoch ||
      loadEpoch !== this.#latestLoadEpoch
    ) {
      return;
    }
    if (cfg.error) {
      this.#last = cfg;
      this.#emit({ config: toMcpConfigStatus(cfg), type: 'config' });
      logger.error('MCP config could not be loaded', { error: cfg.error, path: cfg.path });
      return;
    }
    if (cfg.exists && !cfg.config) {
      throw new Error('Existing MCP config load result is missing resolved configuration');
    }

    const authorityEpoch = ++this.#latestAuthorityEpoch;
    const config = cfg.config ?? { servers: [] };
    const committed = await this.options.runtime.replaceResolvedConfig(config);
    if (authorityEpoch === this.#latestAuthorityEpoch) {
      this.#lastCommittedResolvedConfig = structuredClone(config);
    }
    if (
      this.#lifecycleOpen &&
      lifecycleEpoch === this.#lifecycleEpoch &&
      loadEpoch === this.#latestLoadEpoch &&
      authorityEpoch === this.#latestAuthorityEpoch
    ) {
      this.#last = cfg;
      this.#emit({ config: toMcpConfigStatus(cfg), type: 'config' });
    }

    const discoveries = cfg.config
      ? await discoverToolsFromConfig(this.options.runtime, cfg.config, committed)
      : [];
    if (!this.#isCurrentAuthority(authorityEpoch, lifecycleEpoch)) {
      return;
    }
    const toolIds = new Set(discoveries.flatMap((discovery) => Object.keys(discovery.tools)));
    // Discovery failure never retires preferences; only config removal can.
    const configuredServerNames = new Set(config.servers.map((server) => server.name));
    await withToolPreferencesFileLock(async () => {
      if (!this.#isCurrentAuthority(authorityEpoch, lifecycleEpoch)) {
        return;
      }
      // Empty discovery has no retirement authority. Keep any existing fault.
      const preferences: ToolPreferenceProjection =
        toolIds.size > 0
          ? await loadToolPreferencesForProjection(
              this.options.userDataDir,
              toolIds,
              configuredServerNames
            )
          : { status: 'not-read' };
      if (!this.#isCurrentAuthority(authorityEpoch, lifecycleEpoch)) {
        return;
      }
      // Keep file read, registry publication and notification in the same lock.
      this.#rebuildToolRegistry(discoveries, toolIds, preferences);
      this.#lastToolDiscoveries = discoveries;
      this.#projectedAuthorityEpoch = authorityEpoch;
      this.#emitTools();
    });
  }

  #isCurrentAuthority(authorityEpoch: number, lifecycleEpoch: number): boolean {
    return (
      this.#lifecycleOpen &&
      lifecycleEpoch === this.#lifecycleEpoch &&
      authorityEpoch === this.#latestAuthorityEpoch
    );
  }

  #registerChange<T>(pending: Promise<T>): Promise<T> {
    const settled = pending.then(
      () => undefined,
      () => undefined
    );
    this.#barrier = Promise.all([this.#barrier, settled]).then(() => undefined);
    return pending;
  }

  #trackChange<T>(operation: (lifecycleEpoch: number) => Promise<T>): Promise<T> {
    if (!this.#lifecycleOpen) {
      return Promise.reject(new BoundaryFailureError(MCP_SETTINGS_CLOSED));
    }
    return this.#registerChange(operation(this.#lifecycleEpoch));
  }

  #trackOperation<T>(operation: (lifecycleEpoch: number) => Promise<T>): Promise<T> {
    if (!this.#lifecycleOpen) {
      return Promise.reject(new BoundaryFailureError(MCP_SETTINGS_CLOSED));
    }
    // Non-reentrant by construction: code already inside a tracked operation
    // must call the *ForLifecycle helpers with its captured epoch. Re-entering
    // this queue from an operation would await its own unsettled tail forever.
    const lifecycleEpoch = this.#lifecycleEpoch;
    const pending = this.#operationTail.then(async () => {
      if (!this.#lifecycleOpen || lifecycleEpoch !== this.#lifecycleEpoch) {
        throw new Error('MCP settings lifecycle operation was retired before execution');
      }
      return await operation(lifecycleEpoch);
    });
    this.#operationTail = pending.then(
      () => undefined,
      () => undefined
    );
    return this.#registerChange(pending);
  }

  #handleConfigChange(cfg: LoadedMcpConfig, sourceLifecycleEpoch: number): Promise<void> {
    if (!this.#lifecycleOpen || sourceLifecycleEpoch !== this.#lifecycleEpoch) {
      return Promise.resolve();
    }
    const loadEpoch = ++this.#latestLoadEpoch;
    return this.#trackChange(async (lifecycleEpoch) =>
      this.#applyConfigChange(cfg, loadEpoch, lifecycleEpoch)
    );
  }

  async #reloadForLifecycle(lifecycleEpoch: number): Promise<void> {
    const loadEpoch = ++this.#latestLoadEpoch;
    const config = await this.options.configFile.load();
    await this.#applyConfigChange(config, loadEpoch, lifecycleEpoch);
  }

  #applyConfigPath(resolvedConfigPath: string | null): Promise<HostResults['mcp/config/path/set']> {
    return this.#trackOperation(async (lifecycleEpoch) => {
      await this.options.configFile.setCustomPath(resolvedConfigPath);
      const newPath = await this.options.configFile.path();
      logger.info('Loading config from new path', { path: newPath });
      await this.#reloadForLifecycle(lifecycleEpoch);
      await this.#restartWatcherForLifecycle(lifecycleEpoch);
      return { path: newPath, success: true };
    });
  }

  #resolveAllowedConfigPath(configPath: string | null): string | null {
    if (configPath === null) {
      return null;
    }
    const trimmedPath = configPath.trim();
    if (!(trimmedPath.length > 0 && path.isAbsolute(trimmedPath))) {
      throw new Error('MCP config path must be an absolute path selected by the user.');
    }
    const resolvedPath = path.resolve(trimmedPath);
    if (isPathInsideRoot(path.join(this.options.userDataDir, 'mcp'), resolvedPath)) {
      return resolvedPath;
    }
    if (this.#lastUserSelectedConfigPath && resolvedPath === this.#lastUserSelectedConfigPath) {
      return resolvedPath;
    }
    throw new Error('MCP config path must be selected with the native file picker.');
  }

  async #restartWatcherForLifecycle(lifecycleEpoch: number): Promise<void> {
    this.#stopWatcher();
    const watcher = await this.options.configFile.watch((config) =>
      this.#handleConfigChange(config, lifecycleEpoch)
    );
    if (!this.#lifecycleOpen || lifecycleEpoch !== this.#lifecycleEpoch) {
      watcher.close();
      return;
    }
    this.#unwatch = () => watcher.close();
  }

  #stopWatcher(): void {
    const stop = this.#unwatch;
    this.#unwatch = null;
    stop?.();
  }

  async #controlDestructive(
    request: McpHostControlRequest,
    reloadConfig: () => Promise<void>
  ): Promise<McpHostServerSnapshot> {
    let controlFailure: unknown;
    let result: McpHostServerSnapshot | undefined;
    try {
      result = await this.options.runtime.host.control(request);
    } catch (cause) {
      controlFailure = cause;
    }
    try {
      await reloadConfig();
    } catch (reloadFailure) {
      if (controlFailure !== undefined) {
        throw new AggregateError(
          [controlFailure, reloadFailure],
          'MCP lifecycle control and config reload both failed'
        );
      }
      throw reloadFailure;
    }
    if (controlFailure !== undefined) {
      throw controlFailure;
    }
    if (result === undefined) {
      throw new Error('MCP lifecycle control completed without a result');
    }
    return result;
  }

  #beginCleanup(): unknown[] {
    this.#lifecycleOpen = false;
    this.#lifecycleEpoch += 1;
    this.#latestLoadEpoch += 1;
    this.#latestAuthorityEpoch += 1;
    const failures: unknown[] = [];
    try {
      this.#stopWatcher();
    } catch (error) {
      failures.push(error);
    }
    return failures;
  }

  #purgeProjection(): void {
    this.#last = null;
    this.#lastUserSelectedConfigPath = null;
    this.#toolPreferencesFault = null;
    this.#lastToolDiscoveries = [];
    this.#projectedAuthorityEpoch = this.#latestAuthorityEpoch;
    mcpToolRegistry.clear();
  }

  #captureSnapshot(): McpFactoryResetSnapshot {
    return {
      authorityConfig: structuredClone(this.#lastCommittedResolvedConfig),
      config: this.#last === null ? null : structuredClone(this.#last),
      // Host results passed strict JSON and SDK schema parsing before discovery.
      discoveries: structuredClone(this.#lastToolDiscoveries),
      extensionPreferences: { ...this.options.runtime.mcpExtensionPreferences },
      selectedConfigPath: this.#lastUserSelectedConfigPath,
      // Restored with the rest of the projection: an abandoned reset must not
      // leave writes unblocked while the preferences file is still unreadable.
      toolPreferencesFault: this.#toolPreferencesFault,
      tools: serializableTools(),
    };
  }

  async #restoreSnapshot(snapshot: McpFactoryResetSnapshot): Promise<void> {
    await this.options.runtime.setMcpExtensionPreferences(snapshot.extensionPreferences);
    await this.options.runtime.replaceResolvedConfig(snapshot.authorityConfig);
    this.#lastCommittedResolvedConfig = structuredClone(snapshot.authorityConfig);
    this.#last = snapshot.config;
    this.#lastUserSelectedConfigPath = snapshot.selectedConfigPath;
    this.#toolPreferencesFault = snapshot.toolPreferencesFault;
    this.#lastToolDiscoveries = snapshot.discoveries;
    this.#projectedAuthorityEpoch = this.#latestAuthorityEpoch;
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
}
