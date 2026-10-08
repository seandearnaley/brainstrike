import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostPlatformLaunchOptions, HostStartupContext } from '@brainstrike/agent-host';
import type { KeyringCredentialBackend } from '@brainstrike/agent-host/credential-contract';
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
  };
}
