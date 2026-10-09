import type { SupportedProvider } from '@brainstrike/agent/client';
import {
  findProviderDefinition,
  isProviderCredential,
  MalformedCredentialError,
  type ProviderAuthMode,
  type ProviderCredential,
  type ProviderKeySource,
} from '@brainstrike/assistant-contract';
import type { EnvBootstrapReport } from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import { ipcMain } from 'electron';
import { listAgentProviders } from './agent-client-loader';
import type { DesktopEnvLoadFailure } from './desktop-env';
import {
  decodeProviderArgs,
  decodeProviderCredentialArgs,
  decodeProviderValueArgs,
} from './ipc-secrets-args';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import {
  resolveAwsEnvChainCredential,
  resolveProviderEnvCredential,
  storedAuthMode,
} from './provider-api-key';
import {
  credentialStoredKeyFingerprint,
  credentialToApiKey,
  parseCredentialOrThrow,
  SecretReadError,
  type SecretsService,
} from './secrets';
import { TAVILY_ENV_KEYS } from './tavily-env-keys';

/**
 * Serialize a write failure as data. IPC channels never throw domain errors
 * across invoke — Electron's `ipcRenderer.invoke` rejection path drops custom
 * own-properties (see assistant-contract secret-read-error.ts).
 */
function toWriteErrorResult(err: unknown): {
  readonly error: 'encryption_unavailable' | 'malformed_credential' | 'unknown_error';
  readonly ok: false;
} {
  if (err instanceof MalformedCredentialError) {
    return { error: 'malformed_credential', ok: false };
  }
  if (err instanceof Error && err.message === 'encryption_unavailable') {
    return { error: 'encryption_unavailable', ok: false };
  }
  return { error: 'unknown_error', ok: false };
}

const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
const TAVILY_SECRET_PROVIDER = 'tavily' as const;
type DesktopProviderKeyId = SupportedProvider | typeof TAVILY_SECRET_PROVIDER;

function isTestMode(): boolean {
  const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
  const nodeEnv = process.env['NODE_ENV'];
  return process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test';
}

// In-memory storage for test mode. Values are stored exactly as the encrypted
// store would hold them decrypted: bare strings for legacy saves,
// JSON.stringify(credential) for typed saves — so the typed read path exercises
// the SAME parseStoredCredential mapping as production (BST-1348).
const testModeSecrets = new Map<string, string>();

/**
 * Reads a test-mode value through the SAME credential mapping as the
 * production service (parseCredentialOrThrow — no duplicated interpretation):
 * null strictly for "not set", a typed SecretReadError for a
 * tagged-but-invalid value.
 */
function readTestModeCredential(provider: string): ProviderCredential | null {
  const raw = testModeSecrets.get(provider);
  if (raw === undefined) {
    return null;
  }
  return parseCredentialOrThrow(provider, raw);
}

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

/**
 * Builds one stored-source entry, attaching the save-time fingerprint when
 * the credential carries one. An unreadable credential still lists as stored
 * — that fact stands regardless — but yields no fingerprint; its read failure
 * already surfaces through the status probe and every actual read path.
 */
async function toStoredKeySource(
  provider: DesktopProviderKeyId,
  readCredential: () => Promise<ProviderCredential | null> | ProviderCredential | null
): Promise<ProviderKeySource<DesktopProviderKeyId>> {
  let fingerprint: ReturnType<typeof credentialStoredKeyFingerprint>;
  // BST-1353 (PR #2525 finding 4): the WINNING auth mode has to ride this
  // listing, not just inspectProviderKeys — this is the surface the Credential
  // Inventory renders from, so the badge can only name a mode that arrives
  // here. Derived from the SAME helper the request path uses, so a legacy
  // bare-string key under bedrock still reads as a bearer.
  let authMode: { authMode?: ProviderAuthMode } = {};
  try {
    const credential = await readCredential();
    fingerprint = credential ? credentialStoredKeyFingerprint(credential) : undefined;
    authMode = credential ? storedAuthMode(provider, credential) : {};
  } catch (err) {
    if (!(err instanceof SecretReadError)) {
      throw err;
    }
  }
  return fingerprint
    ? { ...authMode, metadata: fingerprint, provider, source: 'stored' }
    : { ...authMode, provider, source: 'stored' };
}

async function appendTestModeProviders(
  target: Map<DesktopProviderKeyId, ProviderKeySource<DesktopProviderKeyId>>
): Promise<void> {
  const eligible: DesktopProviderKeyId[] = [];
  for (const [provider, value] of testModeSecrets.entries()) {
    const trimmedValue = typeof value === 'string' ? value.trim() : '';
    if (trimmedValue.length === 0 || !isDesktopProviderKeyId(provider)) {
      continue;
    }
    eligible.push(provider);
  }
  // Parallel for parity with the production listing path below.
  const sources = await Promise.all(
    eligible.map((provider) => toStoredKeySource(provider, () => readTestModeCredential(provider)))
  );
  for (const source of sources) {
    target.set(source.provider, source);
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
  // A Set both dedupes in O(1) and PRESERVES insertion order, so the listing
  // order the reads land in below is unchanged (an array + `.includes` rescan
  // was quadratic in the slot count for the same result).
  const eligible = new Set<DesktopProviderKeyId>();
  for (const provider of storedProviders) {
    if (typeof provider !== 'string') {
      continue;
    }
    const trimmed = provider.trim();
    if (
      trimmed.length === 0 ||
      !isDesktopProviderKeyId(trimmed) ||
      target.has(trimmed) ||
      eligible.has(trimmed)
    ) {
      continue;
    }
    eligible.add(trimmed);
  }
  // The per-provider decrypt+parse reads are independent, so they run in
  // parallel (bounded by the slot count); entries land in listing order.
  // Follow-up: fingerprints could be projected WITHOUT a full decrypt if the
  // store persisted the non-secret {last4, savedAt} pair alongside (not
  // inside) the encrypted credential — the listing would then never need
  // key material at all.
  const sources = await Promise.all(
    [...eligible].map((provider) =>
      toStoredKeySource(provider, () => secrets.getCredential(provider))
    )
  );
  for (const source of sources) {
    target.set(source.provider, source);
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
        // Every registry env key is a BEARER token (BST-1353).
        ...storedAuthMode(provider, { key: credential.value, type: 'api_key' }),
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

/**
 * Rung 3 of the AWS precedence table for THIS listing (BST-1353, PR #2525
 * finding 4). Mirrors `applyEnvChainSources` in provider-api-key.ts and must
 * run LAST for the same reason: it overrides a stored CHAIN but never a
 * bearer of either source.
 *
 * Without it a bedrock row configured purely by `AWS_REGION` + `AWS_PROFILE`
 * was missing from the listing entirely — the inventory showed "Not set"
 * while the assistant reported bedrock configured and streamed fine.
 */
function appendEnvChainProviders(
  target: Map<DesktopProviderKeyId, ProviderKeySource<DesktopProviderKeyId>>
): void {
  // Loop-invariant: depends only on process.env (PR #2525 finding 9).
  const envChain = resolveAwsEnvChainCredential(process.env, false);
  if (!envChain) {
    return;
  }
  for (const provider of listAgentProviders()) {
    if (
      !isDesktopProviderKeyId(provider) ||
      findProviderDefinition(provider)?.authType !== 'aws' ||
      target.get(provider)?.authMode === 'bearer'
    ) {
      continue;
    }
    target.set(provider, {
      authMode: 'profile_chain',
      envVar: envChain.envVar,
      provider,
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
  options: {
    readonly envFileFailures?: readonly DesktopEnvLoadFailure[];
    /**
     * Projects the RECORDED env bootstrap (BST-1363). Required — a missing
     * source would silently disable the settings surface whose entire job is
     * to make a silent failure visible. Called per invoke rather than cached
     * so the payload always describes the live process environment.
     */
    readonly readEnvBootstrapReport: () => EnvBootstrapReport;
  }
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const envFileFailures = options.envFileFailures ?? [];

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.save,
    { roles: ['visible-ui'] },
    async (_event, ...args: readonly unknown[]) => {
      const [provider, value] = decodeProviderValueArgs(args);
      // In test mode, use in-memory storage — the api_key JSON ENVELOPE, for
      // parity with the production single write path (saveKey → setCredential).
      if (isTestMode()) {
        const credential = { key: value, type: 'api_key' } as const;
        if (!isProviderCredential(credential)) {
          return { error: 'malformed_credential', ok: false } as const;
        }
        testModeSecrets.set(provider, JSON.stringify(credential));
        return true;
      }

      try {
        return await secrets.saveKey(provider, value);
      } catch (err) {
        return toWriteErrorResult(err);
      }
    }
  );

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.get,
    { roles: ['visible-ui'] },
    async (_event, ...args: readonly unknown[]) => {
      const [provider] = decodeProviderArgs(args);
      // In test mode, check in-memory storage. Read through the SAME
      // credential mapping + string projection as the production service
      // (parseCredentialOrThrow / credentialToApiKey) so a typed variant
      // surfaces the same typed failure instead of leaking a stringified
      // credential (BST-1348).
      if (isTestMode()) {
        const credential = readTestModeCredential(provider);
        if (credential === null) {
          return null;
        }
        return credentialToApiKey(provider, credential);
      }

      const v = await secrets.getKey(provider);
      return v;
    }
  );

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.saveCredential,
    { roles: ['visible-ui'] },
    async (_event, ...args: readonly unknown[]) => {
      const [provider, credential] = decodeProviderCredentialArgs(args);
      // Single validation site: setCredential's guard. Test mode substitutes
      // the same guard because no service backs it.
      if (isTestMode()) {
        if (!isProviderCredential(credential)) {
          return { error: 'malformed_credential', ok: false } as const;
        }
        testModeSecrets.set(provider, JSON.stringify(credential));
        return true;
      }

      try {
        return await secrets.setCredential(provider, credential as ProviderCredential);
      } catch (err) {
        return toWriteErrorResult(err);
      }
    }
  );

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.getCredential,
    { roles: ['visible-ui'] },
    async (_event, ...args: readonly unknown[]) => {
      const [provider] = decodeProviderArgs(args);
      // Failures are serialized as data — invoke drops custom error props.
      try {
        const credential = isTestMode()
          ? readTestModeCredential(provider)
          : await secrets.getCredential(provider);
        return { credential, ok: true } as const;
      } catch (err) {
        if (err instanceof SecretReadError) {
          return { error: err.code, ok: false, provider: err.provider } as const;
        }
        throw err;
      }
    }
  );

  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.delete,
    { roles: ['visible-ui'] },
    async (_event, ...args: readonly unknown[]) => {
      const [provider] = decodeProviderArgs(args);
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
        await appendTestModeProviders(providers);
        return Array.from(providers.values());
      }

      // Merge environment-configured providers with stored secrets so renderer consumers
      // (assistant preferences, etc.) discover env-only setups.
      // Consumers that only want persisted secrets should call secrets:listStored.
      const providers = new Map<DesktopProviderKeyId, ProviderKeySource<DesktopProviderKeyId>>();
      appendEnvConfiguredProviders(providers);
      await appendStoredProviders(providers, secrets);
      // LAST — rung 3 of the AWS precedence table (see the helper).
      appendEnvChainProviders(providers);
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

  // Read-only env bootstrap projection (BST-1363). Deliberately does NOT call
  // throwEnvFileFailures: `secrets:list` throws on a failed env file, but this
  // channel exists precisely to explain that failure, so it must still answer.
  registry.registerAuthorizedInvoke(
    'preferences',
    DESKTOP_IPC_CHANNELS.secrets.envBootstrap,
    { roles: ['visible-ui'] },
    () => options.readEnvBootstrapReport()
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
      }
      // Test mode also wipes the profile store: its disposable file holds the
      // provider, OAuth-engine, MCP bearer and MCP OAuth entries. The host's
      // `auth/clear` behind it also drops the engine's and MCP's in-memory state.
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
