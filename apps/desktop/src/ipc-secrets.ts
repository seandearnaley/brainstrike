import type { SupportedProvider } from '@brainstrike/agent/client';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { listAgentProviders } from './agent-client-loader';
import type { DesktopEnvLoadFailure } from './desktop-env';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { resolveProviderEnvCredential } from './provider-api-key';
import type { SecretsService } from './secrets';
import { TAVILY_ENV_KEYS } from './tavily-env-keys';

const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
const TAVILY_SECRET_PROVIDER = 'tavily' as const;
type DesktopProviderKeyId = SupportedProvider | typeof TAVILY_SECRET_PROVIDER;

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

function isDesktopProviderKeyId(value: string): value is DesktopProviderKeyId {
  return (
    value === TAVILY_SECRET_PROVIDER || listAgentProviders().some((provider) => provider === value)
  );
}

function appendTestModeProviders(
  target: Map<DesktopProviderKeyId, ProviderKeySource<DesktopProviderKeyId>>
) {
  for (const [provider, value] of testModeSecrets.entries()) {
    const trimmedValue = typeof value === 'string' ? value.trim() : '';
    if (trimmedValue.length === 0 || !isDesktopProviderKeyId(provider)) {
      continue;
    }
    target.set(provider, { provider, source: 'stored' });
  }
}

function appendTestModeStoredProviderIds(target: Set<string>): void {
  for (const [provider, value] of testModeSecrets.entries()) {
    if (typeof value === 'string' && value.trim().length > 0) {
      target.add(provider);
    }
  }
}

async function appendStoredProviders(
  target: Map<DesktopProviderKeyId, ProviderKeySource<DesktopProviderKeyId>>,
  secrets: SecretsService
) {
  const storedProviders = await secrets.listProviders();
  for (const provider of storedProviders) {
    if (typeof provider !== 'string') {
      continue;
    }
    const trimmed = provider.trim();
    if (trimmed.length === 0 || !isDesktopProviderKeyId(trimmed) || target.has(trimmed)) {
      continue;
    }
    target.set(trimmed, { provider: trimmed, source: 'stored' });
  }
}

function resolveTavilyEnvVar(): string | undefined {
  for (const envVar of TAVILY_ENV_KEYS) {
    const value = process.env[envVar];
    if (typeof value === 'string' && value.trim().length > 0) {
      return envVar;
    }
  }
  return;
}

function appendEnvConfiguredProviders(
  target: Map<DesktopProviderKeyId, ProviderKeySource<DesktopProviderKeyId>>
) {
  const supportedProviders = listAgentProviders();
  for (const provider of supportedProviders) {
    const credential = resolveProviderEnvCredential(provider);
    if (credential) {
      target.set(provider, {
        envVar: credential.envVar,
        provider,
        source: 'env',
      });
    }
  }

  const tavilyEnvVar = resolveTavilyEnvVar();
  if (tavilyEnvVar) {
    target.set(TAVILY_SECRET_PROVIDER, {
      envVar: tavilyEnvVar,
      provider: TAVILY_SECRET_PROVIDER,
      source: 'env',
    });
  }
}

function throwEnvFileFailures(failures: readonly DesktopEnvLoadFailure[]): void {
  if (failures.length === 0) {
    return;
  }
  throw new Error(failures.map((failure) => failure.message).join(' '));
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
export function registerSecretsIpcHandlers(
  secrets: SecretsService,
  options: { readonly envFileFailures?: readonly DesktopEnvLoadFailure[] } = {}
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const envFileFailures = options.envFileFailures ?? [];

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.save,
    { roles: ['visible-ui'] },
    async (_event, provider: string, value: string) => {
      // In test mode, use in-memory storage
      if (isTestMode()) {
        testModeSecrets.set(provider, value);
        return true;
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

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.get,
    { roles: ['visible-ui'] },
    async (_event, provider: string) => {
      // In test mode, check in-memory storage
      if (isTestMode()) {
        return testModeSecrets.get(provider) ?? null;
      }

      const v = await secrets.getKey(provider);
      return v;
    }
  );

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.delete,
    { roles: ['visible-ui'] },
    async (_event, provider: string) => {
      // In test mode, remove from in-memory storage
      if (isTestMode()) {
        testModeSecrets.delete(provider);
        return true;
      }

      return await secrets.deleteKey(provider);
    }
  );

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.list,
    { roles: ['visible-ui'] },
    async () => {
      throwEnvFileFailures(envFileFailures);

      // In test mode, only use in-memory storage (ignore env vars)
      if (isTestMode()) {
        const providers = new Map<DesktopProviderKeyId, ProviderKeySource<DesktopProviderKeyId>>();
        appendTestModeProviders(providers);
        return Array.from(providers.values());
      }

      // Merge environment-configured providers with stored secrets so renderer consumers
      // (assistant preferences, etc.) discover env-only setups.
      // Consumers that only want persisted secrets should call secrets:listStored.
      const providers = new Map<DesktopProviderKeyId, ProviderKeySource<DesktopProviderKeyId>>();
      appendEnvConfiguredProviders(providers);
      await appendStoredProviders(providers, secrets);
      return Array.from(providers.values());
    }
  );

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.listStored,
    { roles: ['visible-ui'] },
    async () => {
      if (isTestMode()) {
        const providers = new Set<string>();
        appendTestModeStoredProviderIds(providers);
        return Array.from(providers);
      }

      const storedProviders = new Set<string>();
      const providers = await secrets.listProviders();
      for (const provider of providers) {
        if (typeof provider !== 'string') {
          continue;
        }
        const trimmed = provider.trim();
        if (trimmed.length > 0) {
          storedProviders.add(trimmed);
        }
      }
      return Array.from(storedProviders);
    }
  );

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.clearAll,
    { roles: ['visible-ui'] },
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
