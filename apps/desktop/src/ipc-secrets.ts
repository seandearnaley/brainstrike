import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { SecretsService } from './secrets';

export function registerSecretsIpcHandlers(secrets: SecretsService) {
  ipcMain.handle(
    'secrets:save',
    async (_e: IpcMainInvokeEvent, provider: string, value: string) => {
      try {
        return await secrets.saveKey(provider, value);
      } catch (err) {
        if (err instanceof Error && err.message === 'encryption_unavailable') {
          return { ok: false, error: 'encryption_unavailable' } as const;
        }
        return { ok: false, error: 'unknown_error' } as const;
      }
    }
  );

  ipcMain.handle('secrets:get', async (_e: IpcMainInvokeEvent, provider: string) => {
    const v = await secrets.getKey(provider);
    return v;
  });

  ipcMain.handle('secrets:delete', async (_e: IpcMainInvokeEvent, provider: string) => {
    return await secrets.deleteKey(provider);
  });

  ipcMain.handle('secrets:list', async () => {
    return await secrets.listProviders();
  });
}
