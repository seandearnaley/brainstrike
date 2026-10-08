import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostAuthService, HostAuthVerdict, HostClientOrigin } from '@brainstrike/agent-host';
import type { HostLoginCredential } from '@brainstrike/agent-host/protocol';
import type {
  OAuthProviderDescriptor,
  ProviderAuthStartMethod,
  ProviderAuthStatus,
} from '@brainstrike/assistant-contract';
import { findProviderDefinition, isSupportedProvider } from '@brainstrike/assistant-contract';
import { HOST_VERSION } from '@brainstrike/host-lease';
import type { HostCredentials } from '../credentials.js';
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
   * The launching desktop's validated browser opener. Absent (the CLI), no
   * subscription flow can start.
   */
  readonly openExternal?: (url: string) => Promise<void>;
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
    origin: HostClientOrigin | undefined
  ): Promise<ProviderAuthStatus>;
  deleteCredential(provider: string): Promise<boolean>;
  disconnect(provider: string): Promise<ProviderAuthStatus>;
  resolveProviderAuth(
    provider: string,
    origin: HostClientOrigin | undefined
  ): Promise<ProviderAuthInput | undefined>;
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
    openExternal: async (url) => {
      if (!options.openExternal) {
        throw new Error('This host has no interactive browser opener');
      }
      await options.openExternal(url);
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
  return {
    cancel: (provider) => engine.cancel(provider),
    clear: async () => {
      for (const providerId of descriptors.keys()) {
        await engine.disconnect(providerId);
      }
      return await secrets().clearAll();
    },
    connect: async (provider, method, origin) => {
      assertInteractiveProviderAuthOrigin(origin);
      return await engine.start(provider, ...(method === undefined ? [] : ([method] as const)));
    },
    deleteCredential: (provider) => secrets().deleteKey(provider),
    disconnect: (provider) => engine.disconnect(provider),
    resolveProviderAuth: (provider, origin) =>
      createHostProviderAuth({
        credentials: options.credentials,
        env: options.env,
        oauthSubscriptionFetch: createInteractiveSubscriptionFetchFactory({
          appVersion: HOST_VERSION,
          getFreshAccessToken: (providerId) => engine.getFreshAccessToken(providerId),
          origin,
        }),
      })(provider),
    setCredential: async (account, credential) => {
      await secrets().setCredential(account, credential);
    },
    status: (provider) => engine.getStatus(provider),
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
