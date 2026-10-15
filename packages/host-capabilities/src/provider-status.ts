import type { HostEnvFileFailure } from '@brainstrike/agent-host';
import { SecretReadError, type SecretsService } from '@brainstrike/agent-host/credential-contract';
import {
  type DeprecatedEnvVarReport,
  detectDeprecatedProviderEnvVars,
  findProviderDefinition,
  isSupportedProvider,
  type ProviderAuthMode,
  type ProviderCredential,
  type ProviderKeySource,
  type SecretReadErrorCode,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  isBearerCredential,
  normalizeSecretValue,
  normalizeStoredCredential,
  resolveAwsEnvChainCredential,
} from './provider-credentials.js';

const logger = createLogger('ProviderApiKey');

export interface ProviderKeyReadFailure {
  readonly code: SecretReadErrorCode;
  readonly message: string;
  readonly provider: SupportedProvider;
}

export interface ProviderKeyInspection {
  readonly configuredProviders: ProviderKeySource<SupportedProvider>[];
  readonly readFailures: ProviderKeyReadFailure[];
}

export interface ProviderKeyInspectionOptions {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly envKeys: (provider: SupportedProvider) => readonly string[];
  readonly providers: readonly SupportedProvider[];
  readonly secrets: () => Pick<SecretsService, 'getCredential' | 'listProviders'>;
}

type ConfiguredProviderMap = Map<SupportedProvider, ProviderKeySource<SupportedProvider>>;

function isAwsAuthProvider(provider: SupportedProvider): boolean {
  return findProviderDefinition(provider)?.authType === 'aws';
}

/**
 * The auth mode a STORED credential represents, for aws providers only.
 *
 * PR #2525 review, finding 6: a legacy bare-string key stored under bedrock
 * parses as `{type:'api_key'}`, and the credential reader treats it as a
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
  options: ProviderKeyInspectionOptions,
  configured: ConfiguredProviderMap
): void {
  for (const provider of options.providers) {
    const envVar = options
      .envKeys(provider)
      .find((name) => normalizeSecretValue(options.env[name]) !== undefined);
    if (envVar) {
      configured.set(provider, {
        // Every registry env key is a BEARER token, so an env hit on an
        // aws-authType provider is bearer mode by construction (BST-1353).
        ...(isAwsAuthProvider(provider) ? { authMode: 'bearer' as const } : {}),
        envVar,
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
  options: ProviderKeyInspectionOptions,
  configured: ConfiguredProviderMap,
  readFailures: ProviderKeyReadFailure[]
): Promise<void> {
  const secretsService = options.secrets();
  const storedProviders: string[] = await secretsService.listProviders();

  // A Set both dedupes and preserves listing order, so eligibility is decided
  // in listing order. Env-configured providers are already in `configured`.
  const eligible = new Set<SupportedProvider>();
  for (const provider of storedProviders) {
    if (isSupportedProvider(provider) && !configured.has(provider)) {
      eligible.add(provider);
    }
  }

  // Independent reads run in parallel; every failure is CAPTURED rather than
  // thrown, so the verdicts below are applied strictly in listing order and
  // the reported failure order stays deterministic.
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
      if (
        read.error.code === 'credential_type_unsupported' &&
        findProviderDefinition(read.provider)?.authType === 'oauth_subscription'
      ) {
        // A subscription sign-in this reader may not parse: the OAuth engine holds it.
        configured.set(read.provider, { provider: read.provider, source: 'stored' });
        continue;
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
    // A VALID stored credential of ANY type marks the provider configured —
    // the availability verdict and the typed-consumer verdict must agree.
    // Blank legacy api_key strings stay "not configured".
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
 * never a bearer of either source, keeping this listing's verdict identical
 * to what the credential reader resolves on the next request.
 */
function applyEnvChainSources(
  options: ProviderKeyInspectionOptions,
  configured: ConfiguredProviderMap,
  unreadable: ReadonlySet<SupportedProvider>
): void {
  const envChain = resolveAwsEnvChainCredential(options.env, false);
  if (!envChain) {
    return;
  }
  for (const provider of options.providers) {
    if (!isAwsAuthProvider(provider) || configured.get(provider)?.authMode === 'bearer') {
      continue;
    }
    // NO SILENT FALLBACK (PR #2529 review, finding 1): an UNREADABLE stored
    // credential may be a bearer, which outranks the chain; it is reported
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

export async function inspectProviderKeys(
  options: ProviderKeyInspectionOptions
): Promise<ProviderKeyInspection> {
  const configured: ConfiguredProviderMap = new Map();
  const readFailures: ProviderKeyReadFailure[] = [];
  collectEnvBearerSources(options, configured);
  await collectStoredSources(options, configured, readFailures);
  applyEnvChainSources(options, configured, new Set(readFailures.map(({ provider }) => provider)));
  return { configuredProviders: [...configured.values()], readFailures };
}

/** The assistant availability payload a Settings or panel client gates on. */
export type ProviderStatus =
  | {
      readonly deprecatedEnvVars?: readonly DeprecatedEnvVarReport[];
      readonly enabled: false;
      readonly envFileFailures: readonly HostEnvFileFailure[];
      readonly error: 'assistant_configuration_invalid';
      readonly message: string;
      readonly providers: readonly string[];
    }
  | {
      readonly deprecatedEnvVars?: readonly DeprecatedEnvVarReport[];
      readonly enabled: true;
      readonly providerErrors?: readonly (ProviderKeyReadFailure & {
        readonly error: 'api_key_unreadable';
      })[];
      readonly providerKeySources: readonly ProviderKeySource<SupportedProvider>[];
      readonly providers: readonly string[];
    };

export interface ProviderStatusOptions extends ProviderKeyInspectionOptions {
  /** Env files the launching shell rejected; the host never re-reads them. */
  readonly envFileFailures: readonly HostEnvFileFailure[];
}

export async function readProviderStatus(options: ProviderStatusOptions): Promise<ProviderStatus> {
  // BST-1361: rename warnings for deprecated env names, computed from this
  // process's own environment. A rejected env FILE does not suppress them.
  const deprecated = detectDeprecatedProviderEnvVars(options.env);
  const deprecatedEnvVars = deprecated.length > 0 ? { deprecatedEnvVars: deprecated } : {};
  if (options.envFileFailures.length > 0) {
    return {
      ...deprecatedEnvVars,
      enabled: false,
      envFileFailures: options.envFileFailures,
      error: 'assistant_configuration_invalid',
      message: 'Desktop environment configuration is invalid.',
      providers: [],
    };
  }
  const inspection = await inspectProviderKeys(options);
  // Keyed providers only. The built-in on-device provider used to be added
  // unconditionally here ("runs in the renderer with no key, so it is always
  // available"), but it is EMBEDDINGS-ONLY now: advertising it as an available
  // chat provider made the renderer's status validator refuse the whole
  // payload ("provider local has no registry default model"), which reads as
  // "Assistant unavailable". The local SERVERS (Ollama, LM Studio) are
  // discovered by their own probe, not reported here.
  const providers = new Set<string>(inspection.configuredProviders.map(({ provider }) => provider));
  const providerErrors = inspection.readFailures.map((failure) => ({
    ...failure,
    error: 'api_key_unreadable' as const,
  }));
  return {
    ...deprecatedEnvVars,
    enabled: true,
    ...(providerErrors.length > 0 ? { providerErrors } : {}),
    providerKeySources: inspection.configuredProviders,
    providers: [...providers],
  };
}
