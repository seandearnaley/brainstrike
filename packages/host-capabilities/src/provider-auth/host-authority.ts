import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostAuthService, HostAuthVerdict, HostClientOrigin } from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { HostLegacyImport, HostLoginCredential } from '@brainstrike/agent-host/protocol';
import type {
  OAuthProviderDescriptor,
  ProviderAuthStartMethod,
  ProviderAuthStatus,
} from '@brainstrike/assistant-contract';
import { findProviderDefinition, isSupportedProvider } from '@brainstrike/assistant-contract';
import { HOST_VERSION } from '@brainstrike/host-lease';
import type { HostCredentials } from '../credentials.js';
import { migrateLegacySecrets } from '../legacy-secret-migration.js';
import { createHostProviderAuth } from '../provider-auth.js';
import { buildCodexUserAgent, createOpenAiCodexDescriptor } from './descriptors/openai-codex.js';
import { ProviderAuthFlowError } from './errors.js';
import {
  assertInteractiveProviderAuthOrigin,
  createProviderAuthEngine,
} from './provider-auth-engine.js';
import { createInteractiveSubscriptionFetchFactory } from './subscription-fetch.js';

export interface HostAuthorityOptions {
  /** The launch's loopback stand-in for the Codex issuer (isolated E2E only). */
  readonly codexIssuer?: string;
  readonly credentials: HostCredentials;
  /** Test seam: the shipped descriptors are the default. */
  readonly descriptors?: readonly OAuthProviderDescriptor[];
  readonly env: NodeJS.ProcessEnv;
  /** Test seam for every OAuth HTTP request. */
  readonly fetchFn?: typeof fetch;
  /**
   * The launching desktop will import its retired store once this host is
   * ready; until that import settles, every credential use waits for it.
   */
  readonly legacyImportPending?: true;
}

/**
 * The host's single credential authority: the only writer of every credential
 * fact and the owner of the one OAuth engine and refresher for this profile.
 */
export interface HostAuthority extends HostAuthService {
  cancel(provider: string): Promise<ProviderAuthStatus>;
  /** Factory reset: drop engine state (including a rotated in-memory pair), then every entry. */
  clear(): Promise<boolean>;
  connect(
    provider: string,
    method: ProviderAuthStartMethod | undefined,
    origin: HostClientOrigin | undefined,
    openExternal: (url: string) => Promise<void>
  ): Promise<ProviderAuthStatus>;
  deleteCredential(provider: string): Promise<boolean>;
  disconnect(provider: string): Promise<ProviderAuthStatus>;
  resolveProviderAuth(
    provider: string,
    origin: HostClientOrigin | undefined
  ): Promise<ProviderAuthInput | undefined>;
  /** The profile store for the host's other credential readers, behind the same import gate. */
  secrets(): SecretsService;
  setCredential(account: string, credential: HostLoginCredential): Promise<void>;
  status(provider: string): Promise<ProviderAuthStatus>;
  storeProviderCredential(provider: string, credential: HostLoginCredential): Promise<void>;
  verify(provider: string): Promise<HostAuthVerdict>;
}

/** A key credential must match the provider's own authentication form. */
function assertLoginCredential(provider: string, credential: HostLoginCredential): void {
  if (!isSupportedProvider(provider)) {
    throw new Error('Unsupported provider credential login');
  }
  const authType = findProviderDefinition(provider)?.authType;
  if (authType !== 'api_key' && authType !== 'aws') {
    throw new Error(`Provider ${provider} does not accept a credential login`);
  }
  if (credential.type !== authType) {
    throw new Error(`Provider ${provider} requires a ${authType} credential`);
  }
}

export function createHostAuthority(options: HostAuthorityOptions): HostAuthority {
  const userAgent = buildCodexUserAgent(HOST_VERSION);
  const descriptors = new Map(
    (
      options.descriptors ?? [
        createOpenAiCodexDescriptor({
          userAgent,
          ...(options.codexIssuer === undefined ? {} : { issuer: options.codexIssuer }),
        }),
      ]
    ).map((descriptor) => [descriptor.providerId, descriptor])
  );
  const secrets = () => options.credentials.secrets();
  // One engine per host: its single-flight refresher and rotated-pair overlay
  // are the only copy of a refreshing token. A second engine would replay it.
  const engine = createProviderAuthEngine({
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    getDescriptor: (providerId) => {
      const descriptor = descriptors.get(providerId);
      if (!descriptor) {
        throw new ProviderAuthFlowError(
          'unknown_provider',
          `No OAuth provider descriptor registered for "${providerId}".`
        );
      }
      return descriptor;
    },
    // Every flow opens through the client that requested it (`connect`).
    openExternal: async () => {
      throw new Error('A sign-in flow needs its requesting client to open the browser');
    },
    // The engine reads and writes through the same single store.
    secrets: {
      clearAll: () => secrets().clearAll(),
      deleteKey: (provider) => secrets().deleteKey(provider),
      getCredential: (provider) => secrets().getCredential(provider),
      getKey: (provider) => secrets().getKey(provider),
      listProviders: () => secrets().listProviders(),
      saveKey: (provider, value) => secrets().saveKey(provider, value),
      setCredential: (provider, credential) => secrets().setCredential(provider, credential),
    },
  });
  // A launch-declared import holds every credential use until the desktop's
  // import settles; its failure is every use's failure, never an empty store.
  const legacyImport = options.legacyImportPending ? Promise.withResolvers<void>() : undefined;
  legacyImport?.promise.catch(() => undefined);
  const imported = async <T>(use: () => Promise<T>): Promise<T> => {
    await legacyImport?.promise;
    return await use();
  };
  const gatedSecrets: SecretsService = {
    clearAll: () => imported(() => secrets().clearAll()),
    deleteKey: (account) => imported(() => secrets().deleteKey(account)),
    getCredential: (account) => imported(() => secrets().getCredential(account)),
    getKey: (account) => imported(() => secrets().getKey(account)),
    listProviders: () => imported(() => secrets().listProviders()),
    saveKey: (account, value) => imported(() => secrets().saveKey(account, value)),
    setCredential: (account, credential) =>
      imported(() => secrets().setCredential(account, credential)),
  };
  return {
    cancel: (provider) => imported(() => engine.cancel(provider)),
    clear: async () => {
      // Factory reset settles behind the import but works even when it failed.
      await legacyImport?.promise.catch(() => undefined);
      for (const providerId of descriptors.keys()) {
        await engine.disconnect(providerId);
      }
      return await secrets().clearAll();
    },
    connect: (provider, method, origin, openExternal) =>
      imported(async () => {
        assertInteractiveProviderAuthOrigin(origin);
        return await engine.start(provider, method, openExternal);
      }),
    deleteCredential: (provider) => imported(() => secrets().deleteKey(provider)),
    disconnect: (provider) => imported(() => engine.disconnect(provider)),
    importLegacy: async (input: HostLegacyImport) => {
      if ('unavailable' in input) {
        const failure = new Error(
          `The retired credential store could not be read: ${input.unavailable}`
        );
        legacyImport?.reject(failure);
        throw failure;
      }
      try {
        const report = await migrateLegacySecrets({
          destination: options.credentials.store(),
          // The desktop retires its own copy after this verified import returns.
          source: { entries: async () => input.entries, retire: async () => undefined },
        });
        legacyImport?.resolve();
        return report;
      } catch (cause) {
        legacyImport?.reject(cause);
        throw cause;
      }
    },
    resolveProviderAuth: (provider, origin) =>
      imported(() =>
        createHostProviderAuth({
          credentials: options.credentials,
          env: options.env,
          oauthSubscriptionFetch: createInteractiveSubscriptionFetchFactory({
            appVersion: HOST_VERSION,
            getFreshAccessToken: (providerId) => engine.getFreshAccessToken(providerId),
            origin,
          }),
        })(provider)
      ),
    secrets: () => gatedSecrets,
    setCredential: (account, credential) =>
      imported(async () => {
        await secrets().setCredential(account, credential);
      }),
    status: (provider) => imported(() => engine.getStatus(provider)),
    storeProviderCredential: (provider, credential) =>
      imported(async () => {
        assertLoginCredential(provider, credential);
        await secrets().setCredential(provider, credential);
      }),
    verify: (provider) =>
      imported(async () => {
        const result = await engine.getFreshAccessToken(provider);
        // Only the verdict leaves the engine (legal gate constraint 3).
        return result.ok ? { ok: true } : { ok: false, status: result.status };
      }),
  };
}
