import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { z } from 'zod';
import { PlatformAuthSchema } from './platform-wire';

type PlatformAuth = z.output<typeof PlatformAuthSchema>;

/** Confidential launcher channel only: no credential enters the public run schema. */
export async function encodePlatformAuth(
  auth: ProviderAuthInput | undefined
): Promise<PlatformAuth> {
  if (auth?.kind === 'aws' && auth.credentialProvider) {
    if (auth.apiKey !== undefined) {
      throw new Error('The selected AWS credential contains conflicting authentication forms');
    }
    // The canonical desktop owner has already resolved this chain once per run.
    // Its closure stays local; only its resolved, ephemeral identity crosses
    // the private launcher port, just as the existing bearer credential does.
    const { accessKeyId, accountId, credentialScope, expiration, secretAccessKey, sessionToken } =
      await auth.credentialProvider();
    return PlatformAuthSchema.parse({
      identity: {
        accessKeyId,
        secretAccessKey,
        ...(accountId === undefined ? {} : { accountId }),
        ...(credentialScope === undefined ? {} : { credentialScope }),
        ...(expiration === undefined ? {} : { expiration: expiration.toISOString() }),
        ...(sessionToken === undefined ? {} : { sessionToken }),
      },
      kind: 'aws',
      region: auth.region,
    });
  }
  if (auth?.kind === 'custom_fetch') {
    throw new Error(
      'The selected provider requires its interactive authenticated stream capability'
    );
  }
  return PlatformAuthSchema.parse(auth ?? null);
}

export function decodePlatformAuth(input: unknown): ProviderAuthInput | undefined {
  const auth = PlatformAuthSchema.parse(input);
  if (auth?.kind === 'aws' && 'identity' in auth) {
    const { accessKeyId, accountId, credentialScope, expiration, secretAccessKey, sessionToken } =
      auth.identity;
    const resolved = {
      accessKeyId,
      secretAccessKey,
      ...(accountId === undefined ? {} : { accountId }),
      ...(credentialScope === undefined ? {} : { credentialScope }),
      ...(expiration === undefined ? {} : { expiration: new Date(expiration) }),
      ...(sessionToken === undefined ? {} : { sessionToken }),
    };
    return { credentialProvider: async () => resolved, kind: 'aws', region: auth.region };
  }
  return auth ?? undefined;
}
