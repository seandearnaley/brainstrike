/**
 * Typed-credential projections (BST-1352, split out of ./ports on review):
 * ports.ts stays a STRUCTURAL surface (types a host satisfies); this module
 * owns the concrete projections that construct agent values from resolved
 * credentials — the string migration shim and the factory auth-input
 * projection.
 */
import type { ProviderAuthInput } from '@brainstrike/agent';
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

/** Static profile_chain guidance (BST-1350): the mode exists in the stored
 * union ahead of its consumer — AWS profile/credential-chain auth lands with
 * BST-1353. */
const PROFILE_CHAIN_UNSUPPORTED_DETAIL =
  'AWS profile/credential-chain auth is not supported yet (BST-1353); store a Bedrock API key (bearer) instead.';

export interface ProviderAuthProjectionOptions {
  /**
   * Env map consulted for `AWS_REGION` when an aws-auth provider resolves an
   * env bearer key (env credentials are always `api_key`-shaped — they carry
   * no region of their own). Defaults to `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function envAwsRegion(options: ProviderAuthProjectionOptions | undefined): string {
  const env = options?.env ?? process.env;
  return env['AWS_REGION']?.trim() ?? '';
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
 * - `aws`/`profile_chain` throws typed until BST-1353 adds the
 *   credential-provider consumer; `oauth` is minted by its consumer
 *   (BST-1356) and throws here.
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
  const isAwsAuthProvider = findProviderDefinition(provider)?.authType === 'aws';
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
    throw new UnsupportedCredentialTypeError(provider, PROFILE_CHAIN_UNSUPPORTED_DETAIL);
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
