import type { IpcMainInvokeEvent } from 'electron';
import { dialog, ipcMain } from 'electron';
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
    return getMcpConfigPath();
  });

  ipcMain.handle(
    'mcp:config:setPath',
    async (
      _e: IpcMainInvokeEvent,
      configPath: string | null
    ): Promise<{ success: boolean; path: string }> => {
      setCustomMcpConfigPath(configPath);
      const newPath = getMcpConfigPath();
      // Reload config from new path
      last = await loadMcpConfig();
      if (last.config) {
        initClients(last.config);
      } else {
        await disposeClients();
      }
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
      const w = watchMcpConfig((cfg) => {
        last = cfg;
        // Hot-reload clients on config change
        if (cfg.config) {
          initClients(cfg.config);
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
}
