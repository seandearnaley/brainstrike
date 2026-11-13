import { resolveAwsCredentialChain } from '@brainstrike/agent';
import {
  createAwsCredentialChain,
  type ProviderAuthInput,
} from '@brainstrike/agent/provider-runtime';
import { isSupportedProvider } from '@brainstrike/assistant-contract';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';
import type { HostCredentials } from './credentials.ts';
import { createProviderCredentialReader } from './provider-credentials.ts';

/** A keyed provider with no configured credential; the caller names what needed it. */
export class ProviderCredentialMissingError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super('The selected provider has no configured credential');
    this.provider = provider;
    this.name = 'ProviderCredentialMissingError';
  }
}

export interface HostProviderAuthOptions {
  /**
   * The host's Sign in with ChatGPT session: a valid access token per request.
   * A composition that lends none cannot spend a ChatGPT plan, and says so.
   */
  readonly chatGptAccessToken?: () => Promise<string>;
  readonly credentials: HostCredentials;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The one provider-auth resolution every host runs. Precedence: env bearer,
 * stored bearer, env AWS chain, stored AWS chain. A store read failure is
 * never "no credential", and a keyed provider without one refuses visibly.
 */
export function createHostProviderAuth(
  options: HostProviderAuthOptions
): (provider: string) => Promise<ProviderAuthInput | undefined> {
  const readCredential = createProviderCredentialReader(
    // Lazy: an env hit must never open the selected store.
    { getCredential: (provider) => options.credentials.secrets().getCredential(provider) },
    options.env
  );
  return async (provider) => {
    if (!isSupportedProvider(provider)) {
      throw new Error('Unsupported provider credential request');
    }
    const credential = await readCredential(provider);
    if (!credential) {
      throw new ProviderCredentialMissingError(provider);
    }
    // BST-1353: resolve once per admission so typed chain errors survive SDK
    // wrapping and a later run picks up a newly completed `aws sso login`.
    const awsCredentialChain =
      credential.type === 'aws' && credential.mode === 'profile_chain'
        ? await resolveAwsCredentialChain(credential.profile).then((resolved) => () => resolved)
        : createAwsCredentialChain;
    return providerAuthInputFromCredential(provider, credential, {
      awsCredentialChain,
      ...(options.chatGptAccessToken ? { chatGptAccessToken: options.chatGptAccessToken } : {}),
      env: options.env,
    });
  };
}
