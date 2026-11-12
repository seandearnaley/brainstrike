import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostAuthService } from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import {
  getProviderDefinition,
  isSupportedProvider,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { HostCredentials } from '../credentials.ts';
import { createHostProviderAuth } from '../provider-auth.ts';
import { CHATGPT_PROVIDER_ID, createChatGptSignIn } from './chatgpt-sign-in.ts';

export interface HostAuthorityOptions {
  /** Fixture seam: a local Sign in with ChatGPT issuer. */
  readonly chatGptIssuer?: string;
  readonly credentials: HostCredentials;
  readonly env: NodeJS.ProcessEnv;
  /** Opens the system browser on the launching client; absent on a host without one. */
  readonly openExternal?: (url: string) => Promise<void>;
}

/** The host's single credential authority: the only writer of every credential fact. */
export interface HostAuthority extends HostAuthService {
  deleteCredential(provider: string): Promise<boolean>;
  /** A valid ChatGPT access token, for the host's own probe of the signed-in account. */
  resolveChatGptAccessToken(): Promise<string>;
  resolveProviderAuth(provider: string): Promise<ProviderAuthInput | undefined>;
  /** The profile store for the host's other credential readers. */
  secrets(): SecretsService;
  setCredential(account: string, credential: ProviderCredential): Promise<void>;
  storeProviderCredential(provider: string, credential: ProviderCredential): Promise<void>;
}

/** The ChatGPT registration has one writer: its own sign-in. */
function assertNotChatGptSignIn(account: string, credential?: ProviderCredential): void {
  if (account === CHATGPT_PROVIDER_ID || credential?.type === 'chatgpt_sign_in') {
    throw refusalError(
      'input',
      'auth.chatgpt-sign-in-only',
      'A ChatGPT sign-in is not a stored key.',
      'Use Continue with ChatGPT and Sign out in Settings → Providers.'
    );
  }
}

/** A key credential must match the provider's own authentication form. */
function assertLoginCredential(provider: string, credential: ProviderCredential): void {
  assertNotChatGptSignIn(provider, credential);
  if (!isSupportedProvider(provider)) {
    throw refusalError(
      'configuration',
      'auth.provider-unsupported',
      'Unsupported provider credential login',
      'Choose a supported provider.'
    );
  }
  const { authType } = getProviderDefinition(provider);
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
    deleteKey: (account) => secrets().deleteKey(account),
    getCredential: (account) => secrets().getCredential(account),
    getKey: (account) => secrets().getKey(account),
    listProviders: () => secrets().listProviders(),
    saveKey: (account, value) => secrets().saveKey(account, value),
    setCredential: (account, credential) => secrets().setCredential(account, credential),
  };
  const chatGpt = createChatGptSignIn({
    ...(options.chatGptIssuer === undefined ? {} : { issuer: options.chatGptIssuer }),
    ...(options.openExternal === undefined ? {} : { openExternal: options.openExternal }),
    secrets,
  });
  return {
    chatGptCancel: () => chatGpt.cancel(),
    chatGptSignIn: (newAccount) => chatGpt.signIn(newAccount),
    chatGptSignOut: () => chatGpt.signOut(),
    chatGptStatus: (settled) => chatGpt.status(settled),
    deleteCredential: async (account) => {
      assertNotChatGptSignIn(account);
      return await secrets().deleteKey(account);
    },
    resolveChatGptAccessToken: () => chatGpt.accessToken(),
    resolveProviderAuth: async (provider) =>
      await createHostProviderAuth({
        chatGptAccessToken: () => chatGpt.accessToken(),
        credentials: options.credentials,
        env: options.env,
      })(provider),
    secrets: () => storeSecrets,
    setCredential: async (account, credential) => {
      assertNotChatGptSignIn(account, credential);
      await secrets().setCredential(account, credential);
    },
    storeProviderCredential: async (provider, credential) => {
      assertLoginCredential(provider, credential);
      await secrets().setCredential(provider, credential);
    },
  };
}
