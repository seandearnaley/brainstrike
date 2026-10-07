import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import {
  AWS_CHAIN_ACTIVATION_ENV_NAMES,
  findProviderDefinition,
  isSupportedProvider,
  type ProviderCredential,
  providerEnvKeys,
  resolveHostedProviderCredential,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import type { ProviderCredentialReader } from '@brainstrike/assistant-service/ports';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('ProviderApiKey');

export function normalizeSecretValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A typed credential plus where it came from (BST-1352). */
export type ResolvedDesktopProviderCredential = ProviderCredential & {
  source: 'env' | 'stored';
};

/**
 * The ENV-CHAIN ACTIVATION RULE (BST-1353), stated once, here:
 *
 *   `AWS_REGION` is set AND no bearer key was resolved
 *   AND (`AWS_PROFILE` or `AWS_ACCESS_KEY_ID` is present).
 *
 * Why each clause:
 *
 * - **`AWS_REGION` required.** A chain credential still needs a region and
 *   there is no default (the settled BST-1350 rule). Env auth has nowhere
 *   else to carry one.
 * - **No bearer.** Bearer beats chain, always — see the precedence table in
 *   {@link readProviderCredential}. This clause is what makes that true for
 *   the env half.
 * - **An activation variable.** This is the ONE place the chain is gated, and
 *   it is deliberately narrow: a machine with `~/.aws/config` but no AWS
 *   environment at all has NOT asked Brainstrike to sign with ambient
 *   credentials, and silently doing so would pick an identity the user never
 *   chose. Once activation passes, the FULL chain runs (SSO, process creds,
 *   instance roles — see aws-credential-chain.ts); the gate selects the mode,
 *   it does not narrow what the chain may consult.
 *
 * The region is NOT format-checked here on purpose: a malformed `AWS_REGION`
 * must reach the factory's `INVALID_AWS_REGION_DETAIL` rejection rather than
 * silently read as "Bedrock is not configured" (same reasoning as the
 * projection's deliberate `region: ''`).
 */
export function resolveAwsEnvChainCredential(
  env: Readonly<NodeJS.ProcessEnv>,
  hasBearerCredential: boolean
): { readonly credential: ProviderCredential; readonly envVar: string } | undefined {
  if (hasBearerCredential) {
    return;
  }
  const region = normalizeSecretValue(env['AWS_REGION']);
  if (!region) {
    return;
  }
  const activationName = AWS_CHAIN_ACTIVATION_ENV_NAMES.find((name) =>
    normalizeSecretValue(env[name])
  );
  if (!activationName) {
    return;
  }
  const profile = normalizeSecretValue(env['AWS_PROFILE']);
  return {
    credential: {
      mode: 'profile_chain',
      region,
      type: 'aws',
      // Absent profile is legitimate: the chain then uses its own default
      // resolution (which still honors AWS_PROFILE internally).
      ...(profile ? { profile } : {}),
    },
    envVar: activationName,
  };
}

/** Whether a resolved credential carries a BEARER token (any source). */
export function isBearerCredential(credential: ProviderCredential | undefined): boolean {
  if (!credential) {
    return false;
  }
  return (
    credential.type === 'api_key' || (credential.type === 'aws' && credential.mode === 'bearer')
  );
}

/**
 * Normalize a stored api_key credential exactly like the legacy string read
 * (`normalizeSecretValue`): trim the key; a blank key is "not configured".
 * Typed credentials (`oauth`/`aws`) have validated fields and pass through.
 */
export function normalizeStoredCredential(
  credential: ProviderCredential
): ProviderCredential | undefined {
  if (credential.type !== 'api_key') {
    return credential;
  }
  const key = credential.key.trim();
  if (!key) {
    return;
  }
  return key === credential.key ? credential : { ...credential, key };
}

/**
 * Typed credential read (BST-1352), routed through the ONE shared
 * env-authoritative resolution core (`resolveHostedProviderCredential`,
 * BST-979 contract preserved): env hits are `api_key` credentials tagged
 * `source: 'env'`; stored hits come from the BST-1348 `getCredential` and tag
 * `source: 'stored'`. A store read failure with no env credential rethrows
 * (same contract as `readProviderSecretKey`) — never coerced into "not
 * configured".
 */
export function createProviderCredentialReader(
  secrets: Pick<SecretsService, 'getCredential'>,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  envKeys: (provider: SupportedProvider) => readonly string[] = providerEnvKeys
): ProviderCredentialReader {
  return async (provider) => {
    if (!isSupportedProvider(provider)) {
      return;
    }
    const resolution = await resolveHostedProviderCredential({
      envKeyNames: envKeys(provider),
      envSources: [env],
      readCredential: async () => {
        // LAZY store acquisition (BST-1352 review finding 4): an env hit must
        // never construct the keychain-backed service — the core only invokes
        // this callback after the env sources came up empty.
        const stored = await secrets.getCredential(provider);
        return stored === null ? null : normalizeStoredCredential(stored);
      },
    });

    // AWS auth precedence (BST-1353). Two ORTHOGONAL axes, applied in this
    // order — bearer-vs-chain is the PRIMARY one:
    //
    //   1. env bearer      (BRAINSTRIKE_BEDROCK_API_KEY, AWS_BEARER_TOKEN_BEDROCK)
    //   2. stored bearer   ({ type:'aws', mode:'bearer' } in the keychain)
    //   3. env chain       (the activation rule above)
    //   4. stored chain    ({ type:'aws', mode:'profile_chain' } in the keychain)
    //
    // Note that step 2 outranks step 3: a bearer key is an EXPLICIT, Bedrock-
    // specific credential the user typed into Settings, while an AWS
    // environment is ambient and often set for unrelated tooling. Within each
    // mode env still wins over stored, which is why the env chain outranks the
    // stored chain. `resolveHostedProviderCredential` already decided 1-vs-2,
    // so the only work left here is inserting 3 ahead of a stored chain.
    //
    // NO SILENT FALLBACK (PR #2529 review, finding 1): the store-read failure is
    // checked BEFORE rung 3, because a failed read is not "nothing stored" — the
    // entry it could not decrypt may be a stored BEARER, which OUTRANKS the env
    // chain. Selecting the chain here would sign requests with whatever ambient
    // AWS identity happens to be in the environment while the credential the
    // user actually chose is merely unreadable, and nothing would ever say so.
    // The resolver cannot know the intended winner, so it surfaces the failure.
    //
    // This does NOT weaken the healthy path: the core only consults the store
    // after every env source came up empty and never reports `secretReadError`
    // alongside a credential, so an env bearer (rung 1) has already returned
    // above with no failure to surface.
    if (resolution.secretReadError !== undefined) {
      logger.error('Failed to read secrets entry for provider', {
        error: resolution.secretReadError,
        provider,
      });
      throw resolution.secretReadError;
    }

    if (findProviderDefinition(provider)?.authType === 'aws') {
      const envChain = resolveAwsEnvChainCredential(
        env,
        isBearerCredential(resolution.credential ?? undefined)
      );
      if (envChain) {
        return { ...envChain.credential, source: 'env' };
      }
    }

    if (resolution.credential && resolution.source) {
      return { ...resolution.credential, source: resolution.source };
    }
    return;
  };
}
