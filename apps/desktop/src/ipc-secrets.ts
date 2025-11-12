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

/**
 * Clears test mode secrets. Should be called in test cleanup to prevent
 * module-level state leakage between test runs.
 */
export function clearTestModeSecrets(): void {
  if (isTestMode()) {
    testModeSecrets.clear();
  }
}

function appendTestModeProviders(target: Set<string>) {
  for (const [provider, value] of testModeSecrets.entries()) {
    const trimmedValue = typeof value === 'string' ? value.trim() : '';
    if (trimmedValue.length === 0) {
      continue;
    }
    target.add(provider);
  }
}

async function appendStoredProviders(target: Set<string>, secrets: SecretsService) {
  const storedProviders = await secrets.listProviders();
  for (const provider of storedProviders) {
    if (typeof provider !== 'string') {
      continue;
    }
    const trimmed = provider.trim();
    if (trimmed.length === 0) {
      continue;
    }
    target.add(trimmed);
  }
}

/**
 * Registers IPC handlers for secure API key management.
 *
 * **Test Mode Behavior:**
 * When running in test mode (NODE_ENV=test, ELECTRON_IS_E2E_TEST=true, or --test-mode),
 * all secrets are stored in-memory and environment variables are IGNORED to prevent
 * test pollution from host environment. Call `clearTestModeSecrets()` in test cleanup
 * to prevent state leakage between test runs.
 *
 * **Production Behavior:**
 * - Environment variables are checked first (via resolveProviderEnvKey)
 * - Falls back to encrypted platform storage (SecretsService)
 * - Merges both sources in the list operation
 *
 * @param secrets - The platform-specific secrets storage service
 */
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
    // In test mode, only use in-memory storage (ignore env vars)
    if (isTestMode()) {
      const providers = new Set<string>();
      appendTestModeProviders(providers);
      return Array.from(providers);
    }

    // Only return STORED providers, not env-configured ones
    // This ensures "Saved Providers" UI accurately reflects what's in the secrets store
    // and factory reset correctly shows empty list after clearing
    // Environment variables are still used as fallback when reading keys via secrets:get
    const providers = new Set<string>();
    await appendStoredProviders(providers, secrets);
    return Array.from(providers);
  });

  ipcMain.handle('secrets:clearAll', async () => {
    // In test mode, clear in-memory storage
    if (isTestMode()) {
      testModeSecrets.clear();
      return { success: true };
    }

    try {
      const result = await secrets.clearAll();
      return { success: result };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
