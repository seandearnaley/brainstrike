import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostAuthService } from '@brainstrike/agent-host';
import {
  joinCredentialCleanup,
  type SecretsService,
} from '@brainstrike/agent-host/credential-contract';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import {
  findProviderDefinition,
  isSupportedProvider,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { HostCredentials } from '../credentials.js';
import { purgeMcpOAuthRuntimeState } from '../mcp/oauth-client-provider.js';
import { createHostProviderAuth } from '../provider-auth.js';

export interface HostAuthorityOptions {
  readonly credentials: HostCredentials;
  readonly env: NodeJS.ProcessEnv;
}

/** The host's single credential authority: the only writer of every credential fact. */
export interface HostAuthority extends HostAuthService {
  /** Factory reset: every entry, MCP OAuth records and their live providers included. */
  clear(): Promise<boolean>;
  deleteCredential(provider: string): Promise<boolean>;
  resolveProviderAuth(provider: string): Promise<ProviderAuthInput | undefined>;
  /** The profile store for the host's other credential readers. */
  secrets(): SecretsService;
  setCredential(account: string, credential: ProviderCredential): Promise<void>;
  storeProviderCredential(provider: string, credential: ProviderCredential): Promise<void>;
}

/** A key credential must match the provider's own authentication form. */
function assertLoginCredential(provider: string, credential: ProviderCredential): void {
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
      'Choose a provider that takes an API key or AWS credential.'
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
  const secrets = () => options.credentials.secrets();
  // Every reader shares the one profile store, resolved per call.
  const storeSecrets: SecretsService = {
    clearAll: () => secrets().clearAll(),
    deleteKey: (account) => secrets().deleteKey(account),
    getCredential: (account) => secrets().getCredential(account),
    getKey: (account) => secrets().getKey(account),
    listProviders: () => secrets().listProviders(),
    saveKey: (account, value) => secrets().saveKey(account, value),
    setCredential: (account, credential) => secrets().setCredential(account, credential),
  };
  return {
    clear: async () => {
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
    deleteCredential: async (provider) => await secrets().deleteKey(provider),
    resolveProviderAuth: async (provider) =>
      await createHostProviderAuth({ credentials: options.credentials, env: options.env })(
        provider
      ),
    secrets: () => storeSecrets,
    setCredential: async (account, credential) => {
      await secrets().setCredential(account, credential);
    },
    storeProviderCredential: async (provider, credential) => {
      assertLoginCredential(provider, credential);
      await secrets().setCredential(provider, credential);
    },
  };
}
