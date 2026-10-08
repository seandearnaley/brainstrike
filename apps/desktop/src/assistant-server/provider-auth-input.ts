import {
  type AwsCredentialIdentityProvider,
  createAwsCredentialChain,
  type RuntimeData,
  resolveAwsCredentialChain,
} from '@brainstrike/agent';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';

/** Existing credential owner resolves typed chain failures before the SDK boundary. */
export async function deriveAssistantTurnAuthInput(
  runtimeData: RuntimeData,
  credential: Parameters<typeof providerAuthInputFromCredential>[1]
): Promise<ReturnType<typeof providerAuthInputFromCredential>> {
  const provider = runtimeData.provider;
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error(
      'Prepared assistant runtime data is missing its provider; request preparation must stamp it.'
    );
  }
  // BST-1353: resolve once per turn so typed chain errors survive SDK wrapping
  // and a later turn picks up a newly completed aws sso login.
  const awsCredentialChain =
    credential?.type === 'aws' && credential.mode === 'profile_chain'
      ? await preresolveAwsChain(credential.profile)
      : createAwsCredentialChain;
  // Subscription auth lives only in the agent host's engine; with no
  // subscription capability here, an OAuth credential refuses.
  return providerAuthInputFromCredential(provider, credential, { awsCredentialChain });
}

async function preresolveAwsChain(
  profile: string | undefined
): Promise<() => AwsCredentialIdentityProvider> {
  const resolved = await resolveAwsCredentialChain(profile);
  return () => resolved;
}
