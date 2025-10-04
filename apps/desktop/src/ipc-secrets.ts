import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { SecretsService } from './secrets';

function isTestMode(): boolean {
  const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
  const nodeEnv = process.env['NODE_ENV'];
  return process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test';
}

export function registerSecretsIpcHandlers(secrets: SecretsService) {
  ipcMain.handle(
    'secrets:save',
    async (_e: IpcMainInvokeEvent, provider: string, value: string) => {
      // In test mode, accept any provider key
      if (isTestMode()) {
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
    // In test mode, return a mock API key for OpenAI
    if (isTestMode() && provider === 'openai') {
      return 'test-api-key-for-e2e-tests';
    }

    const v = await secrets.getKey(provider);
    return v;
  });

  ipcMain.handle('secrets:delete', async (_e: IpcMainInvokeEvent, provider: string) => {
    // In test mode, always succeed
    if (isTestMode()) {
      return;
    }

    return await secrets.deleteKey(provider);
  });

  ipcMain.handle('secrets:list', async () => {
    // In test mode, return OpenAI as available provider
    if (isTestMode()) {
      return ['openai'];
    }

    return await secrets.listProviders();
  });
}
