import {
  createAwsCredentialChain,
  type ProviderAuthInput,
} from '@brainstrike/agent/provider-runtime';
import {
  isSupportedProvider,
  providerEnvKeys,
  resolveHostedProviderCredential,
} from '@brainstrike/assistant-contract';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';
import type { HostCredentials } from './credentials.js';

export interface HostProviderAuthOptions {
  readonly credentials: HostCredentials;
  readonly env: NodeJS.ProcessEnv;
}

/** Env bearer first, then the selected store; a read failure is never "no credential". */
export function createHostProviderAuth(
  options: HostProviderAuthOptions
): (provider: string) => Promise<ProviderAuthInput | undefined> {
  return async (provider) => {
    if (!isSupportedProvider(provider)) {
      throw new Error('Unsupported provider credential request');
    }
    const resolved = await resolveHostedProviderCredential({
      envKeyNames: providerEnvKeys(provider),
      envSources: [options.env],
      readCredential: () => options.credentials.secrets().getCredential(provider),
    });
    if (resolved.secretReadError !== undefined) {
      throw resolved.secretReadError;
    }
    if (!(resolved.credential && resolved.source)) {
      throw new Error('The selected provider has no configured credential');
    }
    return providerAuthInputFromCredential(
      provider,
      { ...resolved.credential, source: resolved.source },
      {
        awsCredentialChain: createAwsCredentialChain,
        env: options.env,
      }
    );
  };
}
