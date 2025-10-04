import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { SecretsService } from './secrets';

function isTestMode(): boolean {
  const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
  const nodeEnv = process.env['NODE_ENV'];
  return process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test';
}

// In-memory storage for test mode
const testModeSecrets = new Map<string, string>();

export function registerSecretsIpcHandlers(secrets: SecretsService) {
  ipcMain.handle(
    'secrets:save',
    async (_e: IpcMainInvokeEvent, provider: string, value: string) => {
      // In test mode, use in-memory storage
      if (isTestMode()) {
        testModeSecrets.set(provider, value);
        return { ok: true } as const;
      }

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
    // In test mode, check in-memory storage
    if (isTestMode()) {
      return testModeSecrets.get(provider) ?? null;
    }

    const v = await secrets.getKey(provider);
    return v;
  });

  ipcMain.handle('secrets:delete', async (_e: IpcMainInvokeEvent, provider: string) => {
    // In test mode, remove from in-memory storage
    if (isTestMode()) {
      testModeSecrets.delete(provider);
      return;
    }

    return await secrets.deleteKey(provider);
  });

  ipcMain.handle('secrets:list', async () => {
    // In test mode, return providers from in-memory storage
    if (isTestMode()) {
      return Array.from(testModeSecrets.keys());
    }

    return await secrets.listProviders();
  });
}
