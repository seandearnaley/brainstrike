import { isSupportedProvider } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import {
  AWS_CHAIN_ACTIVATION_ENV_NAMES,
  findProviderDefinition,
  type ProviderAuthMode,
  type ProviderCredential,
  type ProviderKeySource,
  resolveHostedProviderCredential,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { getAgentProviderEnvKeys, listAgentProviders } from './agent-client-loader';
import { getSecretsService, SecretReadError, type SecretReadErrorCode } from './secrets';

const logger = createLogger('ProviderApiKey');

function normalizeSecretValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface ResolvedProviderEnvCredential {
  readonly envVar: string;
  readonly value: string;
}

export function resolveProviderEnvCredential(
  provider: SupportedProvider
): ResolvedProviderEnvCredential | undefined {
  const envKeys = getAgentProviderEnvKeys(provider);
  for (const envKey of envKeys) {
    const value = normalizeSecretValue(process.env[envKey]);
    if (value) {
      return { envVar: envKey, value };
    }
  }
  return;
}

export function resolveProviderEnvKey(provider: SupportedProvider): string | undefined {
  return resolveProviderEnvCredential(provider)?.value;
}

export async function readProviderSecretKey(
  provider: SupportedProvider
): Promise<string | undefined> {
  try {
    const secretsService = getSecretsService();
    const value = await secretsService.getKey(provider);
    return normalizeSecretValue(value);
  } catch (error) {
    logger.error('Failed to read secrets entry for provider', { error, provider });
    throw error;
  }
}

export async function readProviderApiKey(provider: SupportedProvider): Promise<string | undefined> {
  const envValue = resolveProviderEnvKey(provider);
  if (envValue) {
    return envValue;
  }
  return await readProviderSecretKey(provider);
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
function isBearerCredential(credential: ProviderCredential | undefined): boolean {
  if (!credential) {
    return false;
  }
  return (
    credential.type === 'api_key' || (credential.type === 'aws' && credential.mode === 'bearer')
  );
}

function isAwsAuthProvider(provider: SupportedProvider): boolean {
  return findProviderDefinition(provider)?.authType === 'aws';
}

/**
 * Normalize a stored api_key credential exactly like the legacy string read
 * (`normalizeSecretValue`): trim the key; a blank key is "not configured".
 * Typed credentials (`oauth`/`aws`) have validated fields and pass through.
 */
function normalizeStoredCredential(credential: ProviderCredential): ProviderCredential | undefined {
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
export async function readProviderCredential(
  provider: SupportedProvider
): Promise<ResolvedDesktopProviderCredential | undefined> {
  const resolution = await resolveHostedProviderCredential({
    envKeyNames: getAgentProviderEnvKeys(provider),
    envSources: [process.env],
    readCredential: async () => {
      // LAZY store acquisition (BST-1352 review finding 4): an env hit must
      // never construct the keychain-backed service — the core only invokes
      // this callback after the env sources came up empty.
      const stored = await getSecretsService().getCredential(provider);
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

  if (isAwsAuthProvider(provider)) {
    const envChain = resolveAwsEnvChainCredential(
      process.env,
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
}

export interface ProviderKeyReadFailure {
  readonly code: SecretReadErrorCode;
  readonly message: string;
  readonly provider: SupportedProvider;
}

export interface ProviderKeyInspection {
  readonly configuredProviders: ProviderKeySource<SupportedProvider>[];
  readonly readFailures: ProviderKeyReadFailure[];
}

type ConfiguredProviderMap = Map<SupportedProvider, ProviderKeySource<SupportedProvider>>;

/**
 * The auth mode a STORED credential represents, for aws providers only.
 *
 * PR #2525 review, finding 6: a legacy bare-string key stored under bedrock
 * parses as `{type:'api_key'}`, and `readProviderCredential` treats it as a
 * BEARER via {@link isBearerCredential}. Deriving the mode from the same
 * predicate keeps the listing and the request path in agreement — reading
 * only `credential.mode` would leave a legacy key with no mode at all, and
 * the env chain would then wrongly override it in the listing while the run
 * still signed with the stored key.
 */
export function storedAuthMode(
  provider: string,
  credential: ProviderCredential
): { authMode?: ProviderAuthMode } {
  if (findProviderDefinition(provider)?.authType !== 'aws') {
    return {};
  }
  if (credential.type === 'aws') {
    return { authMode: credential.mode };
  }
  return isBearerCredential(credential) ? { authMode: 'bearer' } : {};
}

/** Rung 1: env BEARER keys, for every provider that declares env names. */
function collectEnvBearerSources(
  providers: readonly SupportedProvider[],
  configured: ConfiguredProviderMap
): void {
  for (const provider of providers) {
    const environmentCredential = resolveProviderEnvCredential(provider);
    if (environmentCredential) {
      configured.set(provider, {
        // Every registry env key is a BEARER token, so an env hit on an
        // aws-authType provider is bearer mode by construction (BST-1353).
        ...(isAwsAuthProvider(provider) ? { authMode: 'bearer' as const } : {}),
        envVar: environmentCredential.envVar,
        provider,
        source: 'env',
      });
    }
  }
}

/** One provider's stored-credential read, with its failure kept rather than thrown. */
type StoredCredentialRead =
  | { readonly credential: ProviderCredential | null; readonly provider: SupportedProvider }
  | { readonly error: unknown; readonly provider: SupportedProvider };

function isFailedRead(
  read: StoredCredentialRead
): read is { readonly error: unknown; readonly provider: SupportedProvider } {
  return 'error' in read;
}

/** Rungs 2 and 4: stored credentials of any type, skipping env-configured providers. */
async function collectStoredSources(
  configured: ConfiguredProviderMap,
  readFailures: ProviderKeyReadFailure[]
): Promise<void> {
  const secretsService = getSecretsService();
  const storedProviders: string[] = await secretsService.listProviders();

  // A Set both dedupes in O(1) and preserves insertion order, so eligibility
  // is decided in listing order exactly as the sequential loop did. Env-
  // configured providers are already in `configured` (rung 1 ran first), so
  // this decision does not depend on anything the reads below produce.
  const eligible = new Set<SupportedProvider>();
  for (const provider of storedProviders) {
    if (!isSupportedProvider(provider)) {
      continue;
    }
    const supported = provider as SupportedProvider;
    if (!configured.has(supported)) {
      eligible.add(supported);
    }
  }

  // The per-provider decrypt+parse reads are INDEPENDENT, so they run in
  // parallel (same shape as ipc-secrets' appendStoredProviders). Each read is
  // still issued exactly once — `eligible` deduped — and every failure is
  // CAPTURED rather than thrown, so the verdicts below are applied strictly in
  // listing order. Rejecting straight out of `Promise.all` would surface
  // whichever provider happened to fail FIRST IN TIME, making both the thrown
  // error and the `readFailures` order nondeterministic.
  const reads: StoredCredentialRead[] = await Promise.all(
    [...eligible].map(async (provider): Promise<StoredCredentialRead> => {
      try {
        return { credential: await secretsService.getCredential(provider), provider };
      } catch (error) {
        return { error, provider };
      }
    })
  );

  for (const read of reads) {
    if (isFailedRead(read)) {
      if (!(read.error instanceof SecretReadError)) {
        throw read.error;
      }
      logger.error('Stored provider credential is unreadable; reporting provider failure', {
        error: read.error,
        provider: read.provider,
      });
      readFailures.push({
        code: read.error.code,
        message: read.error.message,
        provider: read.provider,
      });
      continue;
    }
    // Typed read (BST-1352 review finding 3): a VALID stored credential of
    // ANY type marks the provider configured — the availability verdict and
    // the typed-consumer verdict must agree. Blank legacy api_key strings
    // stay "not configured" via the same normalization the request path uses.
    const { credential } = read;
    if (credential !== null && normalizeStoredCredential(credential)) {
      configured.set(read.provider, {
        ...storedAuthMode(read.provider, credential),
        provider: read.provider,
        source: 'stored',
      });
    }
  }
}

/**
 * Rung 3: the env chain. Runs LAST because it overrides a stored CHAIN but
 * never a bearer of either source. Keeping this listing's verdict identical
 * to what `readProviderCredential` resolves on the next request is the whole
 * point — if they disagreed, the badge would name a mode the run does not use.
 */
function applyEnvChainSources(
  providers: readonly SupportedProvider[],
  configured: ConfiguredProviderMap,
  unreadable: ReadonlySet<SupportedProvider>
): void {
  // Loop-INVARIANT (PR #2525 review, finding 9): the env chain depends only on
  // process.env, never on the provider, so resolve it ONCE. Inside the loop it
  // re-scanned the environment per provider and read as if it were per-provider.
  const envChain = resolveAwsEnvChainCredential(process.env, false);
  if (!envChain) {
    return;
  }
  for (const provider of providers) {
    // A stored or env BEARER outranks the chain (rungs 1-2 beat rung 3), and
    // a legacy bare-string key under bedrock counts as a bearer — see
    // storedAuthMode.
    if (!isAwsAuthProvider(provider) || configured.get(provider)?.authMode === 'bearer') {
      continue;
    }
    // NO SILENT FALLBACK (PR #2529 review, finding 1 — listing side): an
    // UNREADABLE stored credential may be a bearer, which outranks the chain.
    // `readProviderCredential` now surfaces that failure instead of guessing,
    // so labelling the row `profile_chain` here would announce a mode the next
    // request refuses to use — the exact disagreement this rung exists to
    // avoid. The provider stays out of `configuredProviders` and is reported
    // through `readFailures` alone.
    if (unreadable.has(provider)) {
      continue;
    }
    configured.set(provider, {
      authMode: 'profile_chain',
      envVar: envChain.envVar,
      provider,
      source: 'env',
    });
  }
}

export async function inspectProviderKeys(): Promise<ProviderKeyInspection> {
  const configured: ConfiguredProviderMap = new Map();
  const readFailures: ProviderKeyReadFailure[] = [];
  const supportedProviders = listAgentProviders();

  collectEnvBearerSources(supportedProviders, configured);
  await collectStoredSources(configured, readFailures);
  applyEnvChainSources(
    supportedProviders,
    configured,
    new Set(readFailures.map(({ provider }) => provider))
  );

  return {
    configuredProviders: [...configured.values()],
    readFailures,
  };
}

export async function listConfiguredProviders(): Promise<SupportedProvider[]> {
  return (await inspectProviderKeys()).configuredProviders.map(({ provider }) => provider);
}
