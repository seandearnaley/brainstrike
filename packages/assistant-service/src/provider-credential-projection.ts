/**
 * Typed-credential projections (BST-1352, split out of ./ports on review):
 * ports.ts stays a STRUCTURAL surface (types a host satisfies); this module
 * owns the concrete projections that construct agent values from resolved
 * credentials — the string migration shim and the factory auth-input
 * projection.
 */
import type { AwsCredentialIdentityProvider, ProviderAuthInput } from '@brainstrike/agent';
import { describeSecretReadError, findProviderDefinition } from '@brainstrike/assistant-contract';
import type {
  ProviderApiKeyReader,
  ProviderCredentialReader,
  ResolvedProviderCredential,
} from './ports.js';

/**
 * A typed credential reached a consumer that can only use bearer-key strings.
 * Deliberately SHAPED like the desktop `SecretReadError`
 * (name/code/provider/message — the matchSecretReadError structural contract)
 * so every existing secret-error responder classifies it as the same
 * `api_key_unreadable` wire failure the desktop `getKey` path produced for
 * stored non-api_key credentials. Message text comes from the SHARED
 * assistant-contract builder (never hand-copied); the credential itself is
 * NEVER stringified or echoed.
 */
export class UnsupportedCredentialTypeError extends Error {
  readonly code = 'credential_type_unsupported';
  readonly provider: string;

  constructor(provider: string, detail?: string) {
    // The optional detail is STATIC ticket guidance (e.g. the BST-1353
    // profile_chain pointer) appended to the shared canonical text — never a
    // credential field.
    super(
      detail
        ? `${describeSecretReadError('credential_type_unsupported', provider)} ${detail}`
        : describeSecretReadError('credential_type_unsupported', provider)
    );
    // matchSecretReadError matches structurally on this name (BST-972 A3).
    this.name = 'SecretReadError';
    this.provider = provider;
  }
}

/**
 * Static profile_chain guidance for a host that cannot resolve the chain
 * (BST-1353). Hosted Web is exactly that host: it supplies no
 * `awsCredentialChain` capability, so a stored profile_chain credential is
 * REJECTED there rather than degraded — a browser/server-function runtime has
 * no `~/.aws`, no SSO cache, and no instance role to speak of.
 */
const PROFILE_CHAIN_UNSUPPORTED_DETAIL =
  'AWS profile/credential-chain auth requires the desktop app (it reads your local AWS profiles); store a Bedrock API key (bearer) instead.';

export interface ProviderAuthProjectionOptions {
  /**
   * Builds the AWS default credential chain for a profile. INJECTED, not
   * imported: this is the ONE structural reason Hosted Web can never resolve
   * a profile chain (BST-1353). Desktop main passes
   * `createAwsCredentialChain` from `@brainstrike/agent`; web passes nothing,
   * so a stored `profile_chain` credential throws the typed
   * `credential_type_unsupported` failure instead of silently reaching for
   * ambient cloud credentials on the server.
   *
   * Keeping it an injected capability also keeps the Node-only
   * `@aws-sdk/credential-providers` out of this shared package entirely — the
   * type below is erased at compile time.
   */
  readonly awsCredentialChain?: (profile: string | undefined) => AwsCredentialIdentityProvider;
  /**
   * Env map consulted for `AWS_REGION` when an aws-auth provider resolves an
   * env bearer key (env credentials are always `api_key`-shaped — they carry
   * no region of their own). Defaults to `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The ONE resolution of "the region an env-supplied Bedrock bearer pairs
 * with". Env vars cannot express the aws credential union, so such a bearer
 * arrives as an `api_key` credential with no region of its own and this is
 * where the missing half comes from.
 *
 * Exported (PR #2529 review, finding 3) so the desktop verification probe
 * resolves the region exactly as the request path does. When the probe and
 * the request path each read the environment their own way they drift, and
 * "Test connection" starts disagreeing with what a real turn does.
 *
 * `''` means "no region configured" — deliberately NOT a default: BST-1350
 * settled that Bedrock has no implicit region, and each consumer turns the
 * empty string into its own actionable error.
 */
export function resolveEnvAwsRegion(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return env['AWS_REGION']?.trim() ?? '';
}

function envAwsRegion(options: ProviderAuthProjectionOptions | undefined): string {
  return resolveEnvAwsRegion(options?.env ?? process.env);
}

/**
 * Project a resolved credential onto a factory auth input (BST-1352, aws
 * mapping BST-1350). The ONE credential-type narrow in this package:
 *
 * - `api_key` credentials project to `{ kind: 'api_key' }` — EXCEPT on a
 *   provider whose registry authType is `'aws'` (bedrock), where a bearer key
 *   is aws-shaped auth: it projects to `{ kind: 'aws' }` with the region from
 *   `AWS_REGION` (env bearer keys have no region of their own). A missing
 *   region projects as `''` deliberately: this function's only visible-error
 *   channel is SecretReadError-shaped, and a missing region is a CONFIG
 *   failure — the one factory validator rejects it with the actionable
 *   "Configure an AWS region for Bedrock in Settings" typed error.
 * - `aws`/`bearer` credentials (stored) project to `{ kind: 'aws' }` with the
 *   credential's OWN region; on a non-aws provider they throw typed.
 * - `aws`/`profile_chain` projects to `{ kind: 'aws', region,
 *   credentialProvider }` when — and ONLY when — the caller injected an
 *   `awsCredentialChain` capability (BST-1353). Desktop main does; Hosted Web
 *   does not, so the same credential throws typed there.
 *
 * The string shim below deliberately calls this with NO options, so a
 * profile_chain credential still throws on every bearer-only consumer
 * (persona pins, persistent memory, the OpenRouter metadata endpoint) — a
 * chain has no bearer string to hand them, and returning `undefined` would
 * read as "not configured".
 *
 * (The desktop store's `credentialToApiKey` keeps its own narrow deliberately
 * — that one is the STORE-layer contract, throwing the real desktop
 * `SecretReadError` class.)
 */
export function providerAuthInputFromCredential(
  provider: string,
  credential: ResolvedProviderCredential | undefined,
  options?: ProviderAuthProjectionOptions
): ProviderAuthInput | undefined {
  if (credential === undefined) {
    return;
  }
  const authType = findProviderDefinition(provider)?.authType;
  const isAwsAuthProvider = authType === 'aws';
  if (credential.type === 'api_key') {
    if (isAwsAuthProvider) {
      return { apiKey: credential.key, kind: 'aws', region: envAwsRegion(options) };
    }
    return { apiKey: credential.key, kind: 'api_key' };
  }
  if (credential.type === 'aws' && isAwsAuthProvider) {
    if (credential.mode === 'bearer') {
      return { apiKey: credential.bearerKey, kind: 'aws', region: credential.region };
    }
    // profile_chain (BST-1353). The chain is built ONLY from the injected
    // capability — no import, no fallback. A host that did not supply one
    // cannot resolve local AWS profiles, and says so.
    const buildChain = options?.awsCredentialChain;
    if (!buildChain) {
      throw new UnsupportedCredentialTypeError(provider, PROFILE_CHAIN_UNSUPPORTED_DETAIL);
    }
    return {
      credentialProvider: buildChain(credential.profile),
      kind: 'aws',
      region: credential.region,
    };
  }
  throw new UnsupportedCredentialTypeError(provider);
}

/**
 * The ONE typed→string compatibility adapter (BST-1352 migration shim):
 * presents a {@link ProviderCredentialReader} as the legacy string
 * {@link ProviderApiKeyReader}, COMPOSED over
 * {@link providerAuthInputFromCredential} so the credential-type narrow lives
 * in exactly one place.
 *
 * @deprecated Migration surface only — new consumers take the typed
 * {@link ProviderCredentialReader} directly.
 */
export function createProviderApiKeyReader(
  readCredential: ProviderCredentialReader
): ProviderApiKeyReader {
  return async (provider: string): Promise<string | undefined> => {
    const auth = providerAuthInputFromCredential(provider, await readCredential(provider));
    return auth?.apiKey;
  };
}
