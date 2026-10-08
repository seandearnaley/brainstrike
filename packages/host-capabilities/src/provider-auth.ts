import { resolveAwsCredentialChain } from '@brainstrike/agent';
import {
  createAwsCredentialChain,
  type ProviderAuthInput,
} from '@brainstrike/agent/provider-runtime';
import { findProviderDefinition, isSupportedProvider } from '@brainstrike/assistant-contract';
import {
  type ProviderAuthProjectionOptions,
  providerAuthInputFromCredential,
} from '@brainstrike/assistant-service/provider-credential-projection';
import type { HostCredentials } from './credentials.js';
import { createProviderCredentialReader } from './provider-credentials.js';

export interface HostProviderAuthOptions {
  readonly credentials: HostCredentials;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Subscription OAuth fetch. Only the interactive desktop composition installs
   * it; absent, an `oauth` credential is rejected by the shared projection.
   */
  readonly oauthSubscriptionFetch?: ProviderAuthProjectionOptions['oauthSubscriptionFetch'];
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
      if (findProviderDefinition(provider)?.authType === 'none') {
        return;
      }
      throw new Error('The selected provider has no configured credential');
    }
    // BST-1353: resolve once per admission so typed chain errors survive SDK
    // wrapping and a later run picks up a newly completed `aws sso login`.
    const awsCredentialChain =
      credential.type === 'aws' && credential.mode === 'profile_chain'
        ? await resolveAwsCredentialChain(credential.profile).then((resolved) => () => resolved)
        : createAwsCredentialChain;
    return providerAuthInputFromCredential(provider, credential, {
      awsCredentialChain,
      env: options.env,
      ...(options.oauthSubscriptionFetch
        ? { oauthSubscriptionFetch: options.oauthSubscriptionFetch }
        : {}),
    });
  };
}
