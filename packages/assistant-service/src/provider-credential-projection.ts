/**
 * Typed-credential projections (BST-1352, split out of ./ports on review):
 * ports.ts stays a STRUCTURAL surface (types a host satisfies); this module
 * owns the concrete projections that construct agent values from resolved
 * credentials — the string migration shim and the factory auth-input
 * projection.
 */
import type { ProviderAuthInput } from '@brainstrike/agent';
import { describeSecretReadError } from '@brainstrike/assistant-contract';
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

  constructor(provider: string) {
    super(describeSecretReadError('credential_type_unsupported', provider));
    // matchSecretReadError matches structurally on this name (BST-972 A3).
    this.name = 'SecretReadError';
    this.provider = provider;
  }
}

/**
 * Project a resolved credential onto a factory auth input (BST-1352). The ONE
 * credential-type narrow in this package: `api_key` credentials project to
 * `{ kind: 'api_key' }`; `custom_fetch` is minted by its consumer (BST-1356)
 * and `aws` credential mapping lands with BST-1350/BST-1353, so any other
 * type throws {@link UnsupportedCredentialTypeError}. (The desktop store's
 * `credentialToApiKey` keeps its own narrow deliberately — that one is the
 * STORE-layer contract, throwing the real desktop `SecretReadError` class.)
 */
export function providerAuthInputFromCredential(
  provider: string,
  credential: ResolvedProviderCredential | undefined
): ProviderAuthInput | undefined {
  if (credential === undefined) {
    return;
  }
  if (credential.type !== 'api_key') {
    throw new UnsupportedCredentialTypeError(provider);
  }
  return { apiKey: credential.key, kind: 'api_key' };
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
