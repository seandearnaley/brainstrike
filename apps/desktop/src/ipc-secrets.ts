import { ipcMain } from 'electron';
import { listAgentProviders } from './agent-client-loader';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { resolveProviderEnvKey } from './provider-api-key';
import type { SecretsService } from './secrets';

const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';

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

function appendEnvConfiguredProviders(target: Set<string>) {
  const supportedProviders = listAgentProviders();
  for (const provider of supportedProviders) {
    const envValue = resolveProviderEnvKey(provider);
    if (typeof envValue === 'string' && envValue.length > 0) {
      target.add(provider);
    }
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
export function registerSecretsIpcHandlers(secrets: SecretsService): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.save,
    async (_event, provider: string, value: string) => {
      // In test mode, use in-memory storage
      if (isTestMode()) {
        testModeSecrets.set(provider, value);
        return { ok: true } as const;
      }

      try {
        return await secrets.saveKey(provider, value);
      } catch (err) {
        if (err instanceof Error && err.message === 'encryption_unavailable') {
          return { error: 'encryption_unavailable', ok: false } as const;
        }
        return { error: 'unknown_error', ok: false } as const;
      }
    }
  );

  registry.registerInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.get,
    async (_event, provider: string) => {
      // In test mode, check in-memory storage
      if (isTestMode()) {
        return testModeSecrets.get(provider) ?? null;
      }

      const v = await secrets.getKey(provider);
      return v;
    }
  );

  registry.registerInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.delete,
    async (_event, provider: string) => {
      // In test mode, remove from in-memory storage
      if (isTestMode()) {
        testModeSecrets.delete(provider);
        return;
      }

      return await secrets.deleteKey(provider);
    }
  );

  registry.registerInvoke('preferences', DESKTOP_IPC_CHANNELS.secrets.list, async () => {
    // In test mode, only use in-memory storage (ignore env vars)
    if (isTestMode()) {
      const providers = new Set<string>();
      appendTestModeProviders(providers);
      return Array.from(providers);
    }

    // Merge environment-configured providers with stored secrets so renderer consumers
    // (assistant preferences, etc.) discover env-only setups.
    // Consumers that only want persisted secrets should call secrets:listStored.
    const providers = new Set<string>();
    appendEnvConfiguredProviders(providers);
    await appendStoredProviders(providers, secrets);
    return Array.from(providers);
  });

  registry.registerInvoke('preferences', DESKTOP_IPC_CHANNELS.secrets.listStored, async () => {
    if (isTestMode()) {
      const providers = new Set<string>();
      appendTestModeProviders(providers);
      return Array.from(providers);
    }

    const providers = new Set<string>();
    await appendStoredProviders(providers, secrets);
    return Array.from(providers);
  });

  registry.registerInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.clearAll,
    async (_event, confirmationToken?: string) => {
      if (confirmationToken !== SECRETS_CLEAR_CONFIRMATION_TOKEN) {
        return {
          message: 'Unauthorized: Invalid confirmation token',
          success: false,
        };
      }

      if (isTestMode()) {
        testModeSecrets.clear();
        return { success: true };
      }

      try {
        const result = await secrets.clearAll();
        return { success: result };
      } catch (error) {
        return {
          message: error instanceof Error ? error.message : String(error),
          success: false,
        };
      }
    }
  );

  return () => {
    registry.unregisterAll();
  };
}
