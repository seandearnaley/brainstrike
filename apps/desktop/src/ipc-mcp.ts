import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { disposeClients, initClients } from './mcp';
import { type LoadedMcpConfig, loadMcpConfig, watchMcpConfig } from './mcp-loader';

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
