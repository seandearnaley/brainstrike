import {
  isSupportedProvider,
  loadToolPreferences,
  mcpToolRegistry,
  saveToolPreferences,
  type ToolPreferences,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils';
import type { IpcMainInvokeEvent } from 'electron';
import { app, dialog, ipcMain } from 'electron';
import { disposeClients, initClients } from './mcp';
import {
  getMcpConfigPath,
  type LoadedMcpConfig,
  loadMcpConfig,
  setCustomMcpConfigPath,
  watchMcpConfig,
} from './mcp-loader';
import { readOpenAIApiKey } from './openai-api-key';
import { getSecretsService } from './secrets';

let unwatch: null | (() => void) = null;
let last: LoadedMcpConfig | null = null;
const logger = createLogger('DesktopMcpIpc');

/**
 * Handles config changes by clearing the registry and reinitializing clients.
 * Shared callback for both manual config changes and file watch events.
 */
function handleConfigChange(cfg: LoadedMcpConfig): void {
  last = cfg;
  mcpToolRegistry.clear();
  if (cfg.error) {
    logger.error('MCP config could not be loaded', {
      path: cfg.path,
      error: cfg.error,
    });
  }
  if (cfg.config) {
    initClients(cfg.config);
    void discoverToolsFromConfig(cfg.config);
  } else {
    void disposeClients();
  }
}

async function restartConfigWatcher(): Promise<void> {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
  const watcher = await watchMcpConfig(handleConfigChange);
  unwatch = () => watcher.close();
}

export function registerMcpIpcHandlers(): void {
  logger.info('Registering MCP IPC handlers');

  ipcMain.handle('mcp:config:get', async (): Promise<LoadedMcpConfig> => {
    last = await loadMcpConfig();
    // Initialize MCP clients if config is valid
    if (last.config) {
      initClients(last.config);
    } else {
      await disposeClients();
    }
    return last;
  });

  ipcMain.handle('mcp:config:getPath', async (): Promise<string> => await getMcpConfigPath());

  ipcMain.handle(
    'mcp:config:setPath',
    async (
      _e: IpcMainInvokeEvent,
      configPath: string | null
    ): Promise<{ success: boolean; path: string }> => {
      await setCustomMcpConfigPath(configPath);
      const newPath = await getMcpConfigPath();

      logger.info('Loading config from new path', { path: newPath });
      handleConfigChange(await loadMcpConfig());

      // Restart the watcher to watch the new path
      await restartConfigWatcher();

      return { success: true, path: newPath };
    }
  );

  ipcMain.handle('mcp:config:selectPath', async (): Promise<string | null> => {
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

    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    'mcp:config:watch',
    async (_e: IpcMainInvokeEvent): Promise<{ watching: boolean }> => {
      if (unwatch) {
        return { watching: true };
      }
      const w = await watchMcpConfig(handleConfigChange);
      unwatch = () => w.close();
      return { watching: true };
    }
  );

  ipcMain.handle('mcp:config:unwatch', async (): Promise<{ watching: false }> => {
    if (unwatch) {
      unwatch();
      unwatch = null;
    }
    return { watching: false };
  });

  // Tool management IPC handlers
  ipcMain.handle(
    'mcp:tools:list',
    async (): Promise<ReturnType<typeof mcpToolRegistry.getAllTools>> => {
      const tools = mcpToolRegistry.getAllTools();
      // Serialize to JSON and parse back to ensure all data is cloneable for IPC
      return JSON.parse(JSON.stringify(tools));
    }
  );

  ipcMain.handle(
    'mcp:tools:enable',
    async (_e: IpcMainInvokeEvent, toolIds: string[]): Promise<void> => {
      mcpToolRegistry.enableTools(toolIds);
      await saveToolPreferencesIfNeeded();
    }
  );

  ipcMain.handle(
    'mcp:tools:disable',
    async (_e: IpcMainInvokeEvent, toolIds: string[]): Promise<void> => {
      mcpToolRegistry.disableTools(toolIds);
      await saveToolPreferencesIfNeeded();
    }
  );

  ipcMain.handle(
    'mcp:tools:enableServer',
    async (_e: IpcMainInvokeEvent, serverName: string): Promise<void> => {
      mcpToolRegistry.enableServerTools(serverName);
      await saveToolPreferencesIfNeeded();
    }
  );

  ipcMain.handle(
    'mcp:tools:disableServer',
    async (_e: IpcMainInvokeEvent, serverName: string): Promise<void> => {
      mcpToolRegistry.disableServerTools(serverName);
      await saveToolPreferencesIfNeeded();
    }
  );

  ipcMain.handle('mcp:tools:reset', async (): Promise<void> => {
    mcpToolRegistry.reset();
    await saveToolPreferencesIfNeeded();
  });

  ipcMain.handle('mcp:tools:getStats', async () => mcpToolRegistry.getStats());

  ipcMain.handle(
    'mcp:config:createSample',
    async (): Promise<{ success: boolean; path: string; error?: string }> => {
      try {
        const configPath = await getMcpConfigPath();

        // Sample config using BrainStrike's native format
        // Each server requires: transport, name, and either command (stdio) or url (sse)
        const sampleConfig = {
          servers: [
            {
              // stdio transport: runs a local command
              transport: 'stdio',
              name: 'filesystem',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            },
            {
              // Another stdio example with environment variables
              transport: 'stdio',
              name: 'custom-server',
              command: 'node',
              args: ['path/to/your/mcp-server.js'],
              env: {
                // biome-ignore lint/style/useNamingConvention: Environment variables use SCREAMING_SNAKE_CASE
                API_KEY: 'your-api-key-here',
              },
            },
            {
              // sse transport: connects to a remote HTTP endpoint
              transport: 'sse',
              name: 'remote-api',
              url: 'https://example.com/mcp/sse',
              headers: {
                // biome-ignore lint/style/useNamingConvention: HTTP headers use PascalCase
                Authorization: 'Bearer your-token-here',
              },
            },
          ],
        };

        // Ensure directory exists
        const fsp = await import('node:fs/promises');
        const path = await import('node:path');
        const exists = await fsp
          .access(configPath)
          .then(() => true)
          .catch((error: unknown) => {
            if ((error as { code?: unknown }).code === 'ENOENT') {
              return false;
            }
            throw error;
          });

        if (exists) {
          const error =
            'MCP config already exists. Select the existing file or reset the path before creating a sample.';
          logger.warn('Refusing to overwrite existing MCP config', { path: configPath });
          return { success: false, path: configPath, error };
        }

        await fsp.mkdir(path.dirname(configPath), { recursive: true });

        // Write sample config
        await fsp.writeFile(configPath, JSON.stringify(sampleConfig, null, 2), 'utf-8');
        logger.info('Created sample MCP config', { path: configPath });

        // Clear existing tools, reload config, and ensure file watcher tracks the new file.
        handleConfigChange(await loadMcpConfig());
        await restartConfigWatcher();

        return { success: true, path: configPath };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Failed to create sample MCP config', { error });
        return { success: false, path: '', error: message };
      }
    }
  );

  // Discover tools when config changes; saved preferences are applied after discovery completes
  void discoverMcpToolsOnStartup();
}

async function discoverMcpToolsOnStartup(): Promise<void> {
  logger.info('discoverMcpToolsOnStartup called');
  try {
    const loaded = await loadMcpConfig();
    logger.debug('Loaded MCP config for discovery', { loaded });

    if (!(loaded.exists && loaded.config)) {
      mcpToolRegistry.clear();
      if (loaded.exists && loaded.error) {
        logger.error('MCP config invalid, cleared tool registry', {
          path: loaded.path,
          error: loaded.error,
        });
      } else {
        logger.info('MCP config missing, cleared tool registry');
      }
      return;
    }

    await discoverToolsFromConfig(loaded.config);
  } catch (error) {
    // On error, clear registry to ensure no stale state
    mcpToolRegistry.clear();
    logger.error('Failed to discover MCP tools on startup, cleared registry', { error });
  }
}

async function discoverToolsFromConfig(config: LoadedMcpConfig['config']): Promise<void> {
  if (!config || config.servers.length === 0) {
    logger.info('No MCP servers configured, skipping tool discovery');
    return;
  }

  logger.info('Starting tool discovery', {
    serverCount: config.servers.length,
    servers: config.servers.map((s) => s.name),
  });

  // We need to use Mastra's MCPClient to discover tools
  // Import it dynamically to avoid circular dependencies
  const { createMastraAgentRuntime } = await import('@brainstrike/agent');

  try {
    const credentials = await resolveDiscoveryCredentials();
    if (!credentials) {
      logger.warn('Skipping tool discovery - no provider credentials configured');
      return;
    }

    // Create a temporary runtime just to discover tools
    const runtime = await createMastraAgentRuntime({
      runtime: {
        provider: credentials.provider,
        apiKey: credentials.apiKey,
      },
      mcpConfig: config,
      mcpTimeoutMs: 10_000, // 10 second timeout for discovery
    });

    // Tools are now registered in the global registry
    const stats = mcpToolRegistry.getStats();
    logger.info('Tool discovery complete', stats);

    // Clean up the runtime
    await runtime.dispose();

    // Apply saved tool preferences now that discovery has populated the registry
    await loadToolPreferencesOnStartup();
  } catch (error) {
    logger.error('Failed to discover tools', { error });
    throw error; // Re-throw to see the full error
  }
}

type ProviderId = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'local';

async function resolveDiscoveryCredentials(): Promise<
  { provider: ProviderId; apiKey: string } | undefined
> {
  // First, try to find hosted provider credentials
  try {
    const secrets = getSecretsService();
    const providers = await secrets.listProviders();
    const candidates = providers.filter((p) => p && isSupportedProvider(p));

    // Fetch all keys in parallel to avoid serial latency
    const keys = await Promise.all(candidates.map((p) => secrets.getKey(p)));

    for (let i = 0; i < candidates.length; i++) {
      const key = keys[i];
      if (key && key.trim().length > 0) {
        const resolvedProvider = candidates[i] as ProviderId;
        return { provider: resolvedProvider, apiKey: key };
      }
    }
  } catch (error) {
    logger.error('Unable to read stored provider credentials', { error });
  }

  const envKey = await readOpenAIApiKey();
  if (envKey) {
    return { provider: 'openai', apiKey: envKey };
  }

  // Fall back to local provider - runs entirely in-browser via Transformers.js
  // No API key needed for local inference
  logger.info('No hosted provider credentials found, using local provider');
  return { provider: 'local', apiKey: '' };
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

    // Filter to valid tool IDs only (prevents stale preferences)
    const validEnabled = preferences.enabledTools.filter((id: string) => registeredIds.has(id));
    const validDisabled = preferences.disabledTools.filter((id: string) => registeredIds.has(id));

    const staleCount =
      preferences.enabledTools.length -
      validEnabled.length +
      preferences.disabledTools.length -
      validDisabled.length;

    if (staleCount > 0) {
      logger.info('Filtered stale tool preferences', {
        staleCount,
        registeredCount: registeredIds.size,
      });
    }

    // Apply valid preferences
    if (validDisabled.length > 0) {
      mcpToolRegistry.disableTools(validDisabled);
    }
    if (validEnabled.length > 0) {
      mcpToolRegistry.enableTools(validEnabled);
    }
  } catch (error) {
    logger.error('Failed to load tool preferences', { error });
  }
}
