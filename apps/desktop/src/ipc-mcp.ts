import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  loadToolPreferences,
  mcpToolRegistry,
  saveToolPreferences,
  type ToolPreferences,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { disposeClients, getClient, initClients } from './mcp';
import {
  getDefaultMcpConfigTemplate,
  getMcpConfigPath,
  type LoadedMcpConfig,
  loadMcpConfig,
  type McpServer,
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
const logger = createLogger('DesktopMcpIpc');
const LEGACY_PLACEHOLDER_STDIO_ARG = 'path/to/your/mcp-server.js';
const LEGACY_PLACEHOLDER_SSE_URL = 'https://example.com/mcp/sse';
const MAX_MCP_CONFIG_TEXT_BYTES = 1_000_000;
export const MCP_TOOLS_UPDATED_EVENT = DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsUpdated;

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
 * Handles config changes by clearing the registry and reinitializing clients.
 * Shared callback for both manual config changes and file watch events.
 */
function handleConfigChange(cfg: LoadedMcpConfig): void {
  last = cfg;
  mcpToolRegistry.clear();
  notifyMcpToolsUpdated();
  if (cfg.error) {
    logger.error('MCP config could not be loaded', {
      path: cfg.path,
      error: cfg.error,
    });
  }
  if (cfg.config) {
    initClients(cfg.config);
    void discoverToolsFromConfig(cfg.config).catch((error: unknown) => {
      logger.error('Tool discovery failed after config change', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    void disposeClients();
  }
}

function getSerializableTools(): ReturnType<typeof mcpToolRegistry.getAllTools> {
  return JSON.parse(JSON.stringify(mcpToolRegistry.getAllTools())) as ReturnType<
    typeof mcpToolRegistry.getAllTools
  >;
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

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || !(relative.startsWith('..') || path.isAbsolute(relative));
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
  if (isPathInside(mcpUserDataRoot, resolvedPath)) {
    return resolvedPath;
  }
  if (lastUserSelectedConfigPath && resolvedPath === lastUserSelectedConfigPath) {
    return resolvedPath;
  }
  throw new Error('MCP config path must be selected with the native file picker.');
}

async function restartConfigWatcher(): Promise<void> {
  stopConfigWatcher();
  const watcher = await watchMcpConfig(handleConfigChange);
  unwatch = () => watcher.close();
}

function stopConfigWatcher(): void {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
}

export async function cleanupMcpRuntimeForShutdown(): Promise<void> {
  stopConfigWatcher();
  last = null;
  lastUserSelectedConfigPath = null;
  mcpToolRegistry.clear();
  await disposeClients();
}

export function registerMcpIpcHandlers(): () => void {
  logger.debug('Registering MCP IPC handlers');
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configGet,
    async (): Promise<LoadedMcpConfig> => {
      last = await loadMcpConfig();
      // Initialize MCP clients if config is valid
      if (last.config) {
        initClients(last.config);
      } else {
        await disposeClients();
      }
      return last;
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
    async (_e, configPath: string | null): Promise<{ success: boolean; path: string }> => {
      await setCustomMcpConfigPath(resolveAllowedMcpConfigPath(configPath));
      const newPath = await getMcpConfigPath();

      logger.info('Loading config from new path', { path: newPath });
      handleConfigChange(await loadMcpConfig());

      // Restart the watcher to watch the new path
      await restartConfigWatcher();

      return { success: true, path: newPath };
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
    }> => await readMcpConfigText(true)
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configWriteText,
    async (
      _e,
      content: unknown
    ): Promise<
      { success: true; path: string } | { success: false; path: string; error: string }
    > => {
      const configPath = await getMcpConfigPath();

      if (typeof content !== 'string') {
        return {
          success: false,
          path: configPath,
          error: 'MCP config content must be a string',
        };
      }
      if (content.trim().length === 0) {
        return {
          success: false,
          path: configPath,
          error: 'MCP config content cannot be empty',
        };
      }

      const contentBytes = Buffer.byteLength(content, 'utf-8');
      if (contentBytes > MAX_MCP_CONFIG_TEXT_BYTES) {
        return {
          success: false,
          path: configPath,
          error: `MCP config exceeds ${MAX_MCP_CONFIG_TEXT_BYTES} bytes`,
        };
      }

      const result = await writeMcpConfigText(content);
      if (result.success) {
        logger.info('MCP config text updated', { path: result.path });
        // Path changes restart the watcher in mcp:config:setPath.
        // A write targets the current path, so a watcher restart is unnecessary here.
        handleConfigChange(await loadMcpConfig());
      }
      return result;
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configSelectPath,
    async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'JSON Config', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        title: 'Select MCP Configuration File',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      const selectedPath = result.filePaths[0] ?? null;
      lastUserSelectedConfigPath = selectedPath ? path.resolve(selectedPath) : null;
      return lastUserSelectedConfigPath;
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configWatch,
    async (_e): Promise<{ watching: boolean }> => {
      if (unwatch) {
        return { watching: true };
      }
      const w = await watchMcpConfig(handleConfigChange);
      unwatch = () => w.close();
      return { watching: true };
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configUnwatch,
    async (): Promise<{ watching: false }> => {
      stopConfigWatcher();
      return { watching: false };
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
    async (_e, toolIds: string[]): Promise<void> => {
      mcpToolRegistry.enableTools(toolIds);
      notifyMcpToolsUpdated();
      await saveToolPreferencesIfNeeded();
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsDisable,
    async (_e, toolIds: string[]): Promise<void> => {
      mcpToolRegistry.disableTools(toolIds);
      notifyMcpToolsUpdated();
      await saveToolPreferencesIfNeeded();
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsEnableServer,
    async (_e, serverName: string): Promise<void> => {
      mcpToolRegistry.enableServerTools(serverName);
      notifyMcpToolsUpdated();
      await saveToolPreferencesIfNeeded();
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsDisableServer,
    async (_e, serverName: string): Promise<void> => {
      mcpToolRegistry.disableServerTools(serverName);
      notifyMcpToolsUpdated();
      await saveToolPreferencesIfNeeded();
    }
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsReset,
    async (): Promise<void> => {
      mcpToolRegistry.reset();
      notifyMcpToolsUpdated();
      await saveToolPreferencesIfNeeded();
    }
  );

  registry.registerInvoke('mcp', DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsGetStats, async () =>
    mcpToolRegistry.getStats()
  );

  registry.registerInvoke(
    'mcp',
    DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configCreateSample,
    async (): Promise<{ success: boolean; path: string; error?: string }> => {
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
            return { success: false, path: configPath, error: message };
          }
          throw error;
        }
        logger.info('Created sample MCP config', { path: configPath });

        // Clear existing tools, reload config, and ensure file watcher tracks the new file.
        handleConfigChange(await loadMcpConfig());
        await restartConfigWatcher();

        return { success: true, path: configPath };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Failed to create sample MCP config', { error });
        return { success: false, path: configPath, error: message };
      }
    }
  );

  // Discover tools when config changes; saved preferences are applied after discovery completes
  void discoverMcpToolsOnStartup();

  return () => {
    registry.unregisterAll();
  };
}

async function discoverMcpToolsOnStartup(): Promise<void> {
  logger.debug('discoverMcpToolsOnStartup called');
  try {
    const loaded = await loadMcpConfig();
    logger.debug('Loaded MCP config for discovery', { loaded });

    if (!(loaded.exists && loaded.config)) {
      mcpToolRegistry.clear();
      notifyMcpToolsUpdated();
      if (loaded.exists && loaded.error) {
        logger.error('MCP config invalid, cleared tool registry', {
          path: loaded.path,
          error: loaded.error,
        });
      } else {
        logger.debug('MCP config missing, cleared tool registry');
      }
      return;
    }

    initClients(loaded.config);
    await discoverToolsFromConfig(loaded.config);
  } catch (error) {
    // On error, clear registry to ensure no stale state
    mcpToolRegistry.clear();
    notifyMcpToolsUpdated();
    logger.error('Failed to discover MCP tools on startup, cleared registry', { error });
  }
}

async function discoverToolsFromConfig(config: LoadedMcpConfig['config']): Promise<void> {
  if (!config || config.servers.length === 0) {
    logger.debug('No MCP servers configured, skipping tool discovery');
    return;
  }

  const actionableServers = config.servers.filter((server) => !isPlaceholderServer(server));
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
    return;
  }

  logger.info('Starting tool discovery', {
    serverCount: actionableServers.length,
    servers: actionableServers.map((server) => server.name),
  });

  for (const server of actionableServers) {
    const client = getClient(server.name);
    if (!client) {
      logger.warn('MCP server discovery failed; client not initialized', { server: server.name });
      continue;
    }

    try {
      const tools = await client.listTools();
      mcpToolRegistry.register(
        server.name,
        tools,
        server.enabledTools ? { enabledTools: server.enabledTools } : undefined
      );
    } catch (error) {
      logger.warn('MCP server discovery failed; skipping server', {
        server: server.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stats = mcpToolRegistry.getStats();
  logger.info('Tool discovery complete', stats);
  await loadToolPreferencesOnStartup();
  notifyMcpToolsUpdated();
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
      enabledTools,
      disabledTools,
      version: 1,
      lastUpdated: Date.now(),
    });
  } catch (error) {
    logger.error('Failed to save tool preferences', { error });
  }
}

async function loadToolPreferencesOnStartup(): Promise<void> {
  try {
    const preferences = (await loadToolPreferences(app.getPath('userData'))) as
      | ToolPreferences
      | undefined;
    if (!preferences) {
      return;
    }

    const registeredIds = new Set(getFlattenedTools().map((t) => t.id));
    const validEnabled = preferences.enabledTools.filter((id: string) => registeredIds.has(id));
    const validDisabled = preferences.disabledTools.filter((id: string) => registeredIds.has(id));

    const staleCount =
      preferences.enabledTools.length -
      validEnabled.length +
      preferences.disabledTools.length -
      validDisabled.length;

    if (staleCount > 0) {
      logger.warn('Discarded stale MCP tool preference ids', {
        staleCount,
        registeredCount: registeredIds.size,
      });

      try {
        await saveToolPreferences(app.getPath('userData'), {
          enabledTools: validEnabled,
          disabledTools: validDisabled,
          version: preferences.version,
          lastUpdated: Date.now(),
        });
      } catch (saveError) {
        logger.warn('Failed to persist cleaned tool preferences', { error: saveError });
      }
    }

    // Apply valid preferences
    if (validDisabled.length > 0) {
      mcpToolRegistry.disableTools(validDisabled);
    }
    if (validEnabled.length > 0) {
      mcpToolRegistry.enableTools(validEnabled);
    }
    notifyMcpToolsUpdated();
  } catch (error) {
    logger.error('Failed to load tool preferences', { error });
  }
}
