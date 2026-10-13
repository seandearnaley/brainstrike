import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostAuthService, HostAuthVerdict, HostClientOrigin } from '@brainstrike/agent-host';
import {
  joinCredentialCleanup,
  type SecretsService,
} from '@brainstrike/agent-host/credential-contract';
import type { HostLoginCredential } from '@brainstrike/agent-host/protocol';
import type {
  OAuthProviderDescriptor,
  ProviderAuthStartMethod,
  ProviderAuthStatus,
} from '@brainstrike/assistant-contract';
import {
  findProviderDefinition,
  isSupportedProvider,
  refusalError,
} from '@brainstrike/assistant-contract';
import { HOST_VERSION } from '@brainstrike/host-lease';
import type { HostCredentials } from '../credentials.js';
import { purgeMcpOAuthRuntimeState } from '../mcp/oauth-client-provider.js';
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
}

/**
 * The host's single credential authority: the only writer of every credential
 * fact and the owner of the one OAuth engine and refresher for this profile.
 */
export interface HostAuthority extends HostAuthService {
  cancel(provider: string): Promise<ProviderAuthStatus>;
  /**
   * Factory reset: drop engine state (including a rotated in-memory pair), then every
   * entry, MCP OAuth records and their live providers included.
   */
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
  /** The profile store for the host's other credential readers. */
  secrets(): SecretsService;
  setCredential(account: string, credential: HostLoginCredential): Promise<void>;
  status(provider: string): Promise<ProviderAuthStatus>;
  storeProviderCredential(provider: string, credential: HostLoginCredential): Promise<void>;
  verify(provider: string): Promise<HostAuthVerdict>;
}

/** A key credential must match the provider's own authentication form. */
function assertLoginCredential(provider: string, credential: HostLoginCredential): void {
  if (!isSupportedProvider(provider)) {
    throw refusalError(
      'configuration',
      'auth.provider-unsupported',
      'Unsupported provider credential login',
      'Choose a supported provider.'
    );
  }
  const authType = findProviderDefinition(provider)?.authType;
  if (authType !== 'api_key' && authType !== 'aws') {
    throw refusalError(
      'authorization',
      'auth.credential-login-unavailable',
      'This provider does not accept a credential login',
      'Connect subscription providers from the desktop Settings.'
    );
  }
  if (credential.type !== authType) {
    throw refusalError(
      'input',
      'auth.credential-type-invalid',
      `This provider requires a ${authType} credential`,
      'Supply the credential type declared by the selected provider.'
    );
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
  // Every reader and the engine share the one profile store, resolved per call.
  const storeSecrets: SecretsService = {
    clearAll: () => secrets().clearAll(),
    deleteKey: (account) => secrets().deleteKey(account),
    getCredential: (account) => secrets().getCredential(account),
    getKey: (account) => secrets().getKey(account),
    listProviders: () => secrets().listProviders(),
    saveKey: (account, value) => secrets().saveKey(account, value),
    setCredential: (account, credential) => secrets().setCredential(account, credential),
  };
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
    secrets: storeSecrets,
  });
  return {
    cancel: async (provider) => await engine.cancel(provider),
    clear: async () => {
      for (const providerId of descriptors.keys()) {
        await engine.disconnect(providerId);
      }
      let cleared = false;
      await joinCredentialCleanup(
        [
          secrets()
            .clearAll()
            .then((value) => {
              cleared = value;
            }),
        ],
        'Credential reset completed with failures.',
        // MCP OAuth records sit under their own accounts, outside the secrets namespace:
        // live MCP OAuth providers disconnect, then every registered store clears.
        () => [purgeMcpOAuthRuntimeState()]
      );
      return cleared;
    },
    connect: async (provider, method, origin, openExternal) => {
      assertInteractiveProviderAuthOrigin(origin);
      return await engine.start(provider, method, openExternal);
    },
    deleteCredential: async (provider) => await secrets().deleteKey(provider),
    disconnect: async (provider) => await engine.disconnect(provider),
    resolveProviderAuth: async (provider, origin) =>
      await createHostProviderAuth({
        credentials: options.credentials,
        env: options.env,
        oauthSubscriptionFetch: createInteractiveSubscriptionFetchFactory({
          appVersion: HOST_VERSION,
          getFreshAccessToken: (providerId) => engine.getFreshAccessToken(providerId),
          origin,
        }),
      })(provider),
    secrets: () => storeSecrets,
    setCredential: async (account, credential) => {
      await secrets().setCredential(account, credential);
    },
    status: async (provider) => await engine.getStatus(provider),
    storeProviderCredential: async (provider, credential) => {
      assertLoginCredential(provider, credential);
      await secrets().setCredential(provider, credential);
    },
    verify: async (provider) => {
      const result = await engine.getFreshAccessToken(provider);
      // Only the verdict leaves the engine (legal gate constraint 3).
      return result.ok ? { ok: true } : { ok: false, status: result.status };
    },
  };
}
