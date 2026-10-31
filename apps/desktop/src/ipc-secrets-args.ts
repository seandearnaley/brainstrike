/**
 * Argument schemas for the `secrets:*` IPC handlers in `ipc-secrets.ts`.
 * Main-only: the dispatcher decodes them, so the arity is exact and the
 * provider id is checked before it can key the secrets store. The credential
 * payload of `saveCredential` stays `unknown` on purpose: `setCredential`'s
 * guard is its single validator, and its refusal reaches Settings as
 * `malformed_credential`.
 */
import { Schema } from 'effect';

const MAX_PROVIDER_ID_LENGTH = 256;
const PROVIDER_ID_MESSAGE =
  `secrets IPC provider must be a non-empty string of at most ${MAX_PROVIDER_ID_LENGTH} ` +
  'characters with no control characters.';

const CONTROL_CHARACTER = /\p{Cc}/u;

function isPrintableProviderId(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_PROVIDER_ID_LENGTH && !CONTROL_CHARACTER.test(value)
  );
}

const providerId = Schema.String.annotate({ message: PROVIDER_ID_MESSAGE }).check(
  Schema.makeFilter(isPrintableProviderId, { message: PROVIDER_ID_MESSAGE })
);

const secretValue = Schema.String.annotate({ message: 'secrets IPC value must be a string.' });

/** `secrets:get`, `secrets:getCredential`, `secrets:delete`: `(provider)`. */
export const ProviderArgs = Schema.Tuple([providerId]);

/** `secrets:save`: `(provider, value)`. */
export const ProviderValueArgs = Schema.Tuple([providerId, secretValue]);

/** `secrets:saveCredential`: `(provider, credential)`; the credential is validated downstream. */
export const ProviderCredentialArgs = Schema.Tuple([providerId, Schema.Unknown]);
