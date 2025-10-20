import type { SupportedProvider } from '@brainstrike/agent/client';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { listAgentProviders } from './agent-client-loader';
import { resolveProviderEnvKey } from './provider-api-key';
import type { SecretsService } from './secrets';

function isTestMode(): boolean {
  const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
  const nodeEnv = process.env['NODE_ENV'];
  return process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test';
}

// In-memory storage for test mode
const testModeSecrets = new Map<string, string>();

function resolveEnvConfiguredProviders(): SupportedProvider[] {
  const configured: SupportedProvider[] = [];
  for (const provider of listAgentProviders()) {
    const value = resolveProviderEnvKey(provider);
    if (value) {
      configured.push(provider);
    }
  }
  return configured;
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

    // In production, include both env-configured and stored providers
    const providers = new Set<string>(resolveEnvConfiguredProviders());
    await appendStoredProviders(providers, secrets);
    return Array.from(providers);
  });
}
