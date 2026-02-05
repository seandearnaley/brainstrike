import {
  isSupportedProvider,
  loadToolPreferences,
  mcpToolRegistry,
  saveToolPreferences,
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

export function registerMcpIpcHandlers() {
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

      // Reload config from new path
      last = await loadMcpConfig();
      if (last.config) {
        initClients(last.config);
        // Discover tools from the new config
        void discoverToolsFromConfig(last.config);
      } else {
        await disposeClients();
      }

      // Restart the watcher to watch the new path
      if (unwatch) {
        unwatch();
        unwatch = null;
      }
      const w = await watchMcpConfig((cfg) => {
        last = cfg;
        if (cfg.config) {
          initClients(cfg.config);
          void discoverToolsFromConfig(cfg.config);
        } else {
          void disposeClients();
        }
      });
      unwatch = () => w.close();

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
      const w = await watchMcpConfig((cfg) => {
        last = cfg;
        // Hot-reload clients on config change
        if (cfg.config) {
          initClients(cfg.config);
          // Discover tools from the new config
          void discoverToolsFromConfig(cfg.config);
        } else {
          void disposeClients();
        }
      });
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

  // Discover tools when config changes; saved preferences are applied after discovery completes
  void discoverMcpToolsOnStartup();
}

async function discoverMcpToolsOnStartup(): Promise<void> {
  logger.info('discoverMcpToolsOnStartup called');
  try {
    const loaded = await loadMcpConfig();
    logger.debug('Loaded MCP config for discovery', { loaded });
    if (loaded.config) {
      await discoverToolsFromConfig(loaded.config);
    } else {
      logger.info('No MCP config found, skipping discovery');
    }
  } catch (error) {
    logger.error('Failed to discover MCP tools on startup', { error });
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
    for (const candidate of providers) {
      if (!(candidate && isSupportedProvider(candidate))) {
        continue;
      }
      const key = await secrets.getKey(candidate);
      if (key && key.trim().length > 0) {
        const resolvedProvider = candidate as ProviderId;
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

async function saveToolPreferencesIfNeeded(): Promise<void> {
  try {
    const allTools = mcpToolRegistry.getAllTools();
    const enabledTools: string[] = [];
    const disabledTools: string[] = [];

    for (const [, tools] of Object.entries(allTools)) {
      if (!Array.isArray(tools)) {
        continue;
      }
      for (const tool of tools) {
        if (tool.enabled) {
          enabledTools.push(tool.id);
        } else {
          disabledTools.push(tool.id);
        }
      }
    }

    const preferences = {
      enabledTools,
      disabledTools,
      version: 1,
      lastUpdated: Date.now(),
    };

    await saveToolPreferences(app.getPath('userData'), preferences);
  } catch (error) {
    logger.error('Failed to save tool preferences', { error });
  }
}

async function loadToolPreferencesOnStartup(): Promise<void> {
  try {
    const preferences = await loadToolPreferences(app.getPath('userData'));
    if (preferences) {
      // Apply preferences after tools are discovered
      if (preferences.disabledTools.length > 0) {
        mcpToolRegistry.disableTools(preferences.disabledTools);
      }
      if (preferences.enabledTools.length > 0) {
        mcpToolRegistry.enableTools(preferences.enabledTools);
      }
    }
  } catch (error) {
    logger.error('Failed to load tool preferences', { error });
  }
}
