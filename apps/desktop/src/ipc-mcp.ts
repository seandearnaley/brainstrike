import { loadToolPreferences, mcpToolRegistry, saveToolPreferences } from '@brainstrike/agent';
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

let unwatch: null | (() => void) = null;
let last: LoadedMcpConfig | null = null;

export function registerMcpIpcHandlers() {
  console.log('[ipc-mcp] Registering MCP IPC handlers');

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

  ipcMain.handle('mcp:config:getPath', async (): Promise<string> => {
    return await getMcpConfigPath();
  });

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
      if (unwatch) return { watching: true };
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

  ipcMain.handle('mcp:tools:getStats', async () => {
    return mcpToolRegistry.getStats();
  });

  // Discover tools when config changes; saved preferences are applied after discovery completes
  void discoverMcpToolsOnStartup();
}

async function discoverMcpToolsOnStartup(): Promise<void> {
  console.log('[ipc-mcp] discoverMcpToolsOnStartup called');
  try {
    const loaded = await loadMcpConfig();
    console.log('[ipc-mcp] Loaded config:', loaded);
    if (loaded.config) {
      await discoverToolsFromConfig(loaded.config);
    } else {
      console.log('[ipc-mcp] No config found, skipping discovery');
    }
  } catch (error) {
    console.error('[ipc-mcp] Failed to discover MCP tools on startup:', error);
  }
}

async function discoverToolsFromConfig(config: LoadedMcpConfig['config']): Promise<void> {
  if (!config || config.servers.length === 0) {
    console.info('[ipc-mcp] No MCP servers configured, skipping tool discovery');
    return;
  }

  console.info(
    '[ipc-mcp] Starting tool discovery for',
    config.servers.length,
    'MCP servers:',
    config.servers.map((s) => s.name).join(', ')
  );

  // We need to use Mastra's MCPClient to discover tools
  // Import it dynamically to avoid circular dependencies
  const { createMastraAgentRuntime } = await import('@brainstrike/agent');

  try {
    // Create a temporary runtime just to discover tools
    const runtime = await createMastraAgentRuntime({
      mcpConfig: config,
      mcpTimeoutMs: 10000, // 10 second timeout for discovery
    });

    // Tools are now registered in the global registry
    const stats = mcpToolRegistry.getStats();
    console.info('[ipc-mcp] Tool discovery complete:', stats);

    // Clean up the runtime
    await runtime.dispose();

    // Apply saved tool preferences now that discovery has populated the registry
    await loadToolPreferencesOnStartup();
  } catch (error) {
    console.error('[ipc-mcp] Failed to discover tools:', error);
    throw error; // Re-throw to see the full error
  }
}

async function saveToolPreferencesIfNeeded(): Promise<void> {
  try {
    const allTools = mcpToolRegistry.getAllTools();
    const enabledTools: string[] = [];
    const disabledTools: string[] = [];

    for (const [, tools] of Object.entries(allTools)) {
      if (!Array.isArray(tools)) continue;
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
    console.error('Failed to save tool preferences:', error);
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
    console.error('Failed to load tool preferences:', error);
  }
}
