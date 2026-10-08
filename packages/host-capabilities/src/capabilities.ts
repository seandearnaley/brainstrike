import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostPlatformLaunchOptions, HostStartupContext } from '@brainstrike/agent-host';
import type { KeyringCredentialBackend } from '@brainstrike/agent-host/credential-contract';
import type { HostLoginCredential } from '@brainstrike/agent-host/protocol';
import { findProviderDefinition, isSupportedProvider } from '@brainstrike/assistant-contract';
import { createHostCredentials, type HostCredentials } from './credentials.js';
import { createHostProviderAuth } from './provider-auth.js';

/**
 * The Node capabilities every host composes, desktop and CLI alike. A shell
 * contributes only Electron-bound seams through narrow adapters; everything
 * else is constructed here once per Root and closed with the host.
 */
export interface HostCapabilities {
  close(): Promise<void>;
  readonly credentials: HostCredentials;
  resolveProviderAuth(provider: string): Promise<ProviderAuthInput | undefined>;
  /** The single writer of user-supplied keys; subscription OAuth never logs in this way. */
  storeProviderCredential(provider: string, credential: HostLoginCredential): Promise<void>;
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

export interface HostCapabilitiesOptions {
  /** Trusted fixture seam only; production uses the native keyring worker. */
  readonly createNativeCredentialBackend?: (service: string) => KeyringCredentialBackend;
  readonly env: NodeJS.ProcessEnv;
  /** Trusted process launch selection; never inferred or defaulted. */
  readonly launch: HostPlatformLaunchOptions | undefined;
  readonly startup: HostStartupContext;
}

export async function createHostCapabilities(
  options: HostCapabilitiesOptions
): Promise<HostCapabilities> {
  const credentials = createHostCredentials({
    ...(options.createNativeCredentialBackend
      ? { createNativeBackend: options.createNativeCredentialBackend }
      : {}),
    selection: options.launch?.credentialStore,
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= credentials.close();
    return closing;
  };
  // Own the credential lane before any capability can start native work.
  await options.startup.register(close);
  return {
    close,
    credentials,
    resolveProviderAuth: createHostProviderAuth({ credentials, env: options.env }),
    storeProviderCredential: async (provider, credential) => {
      assertLoginCredential(provider, credential);
      await credentials.secrets().setCredential(provider, credential);
    },
  };
}
