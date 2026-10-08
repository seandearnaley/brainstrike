import type {
  HostPlatformLaunchOptions,
  HostProviderService,
  HostStartupContext,
} from '@brainstrike/agent-host';
import type { KeyringCredentialBackend } from '@brainstrike/agent-host/credential-contract';
import { createHostCredentials, type HostCredentials } from './credentials.js';
import { createTavilyKeyResolver } from './native-tools/web-search-tool.js';
import { createHostAuthority, type HostAuthority } from './provider-auth/host-authority.js';
import { createHostProviderServices } from './provider-services.js';

/**
 * The Node capabilities every host composes, desktop and CLI alike. A shell
 * contributes only Electron-bound seams through narrow adapters; everything
 * else is constructed here once per Root and closed with the host.
 */
export interface HostCapabilities {
  /** The single credential writer, token holder and OAuth refresher of this host. */
  readonly auth: HostAuthority;
  close(): Promise<void>;
  readonly credentials: HostCredentials;
  /** Provider availability, probes and model metadata, read from this store. */
  readonly providers: HostProviderService;
  /** The Tavily key for host-executed web search: env first, then this host's store. */
  resolveTavilyApiKey(): Promise<string | undefined>;
}

export interface HostCapabilitiesOptions {
  /** Trusted fixture seam only; production uses the native keyring worker. */
  readonly createNativeCredentialBackend?: (service: string) => KeyringCredentialBackend;
  readonly env: NodeJS.ProcessEnv;
  /** Trusted process launch selection; never inferred or defaulted. */
  readonly launch: HostPlatformLaunchOptions | undefined;
  /** The launching desktop's validated browser opener; the CLI has none. */
  readonly openExternal?: (url: string) => Promise<void>;
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
  const auth = createHostAuthority({
    ...(options.launch?.openAiCodexIssuer === undefined
      ? {}
      : { codexIssuer: options.launch.openAiCodexIssuer }),
    credentials,
    env: options.env,
    ...(options.launch?.legacyImportPending ? { legacyImportPending: true } : {}),
    ...(options.openExternal ? { openExternal: options.openExternal } : {}),
  });
  return {
    auth,
    close,
    credentials,
    providers: createHostProviderServices({
      auth,
      env: options.env,
      envFileFailures: options.launch?.envFileFailures ?? [],
    }),
    // Through the gated secrets: a pending legacy import settles before the key is read.
    resolveTavilyApiKey: createTavilyKeyResolver(options.env, (account) =>
      auth.secrets().getKey(account)
    ),
  };
}
