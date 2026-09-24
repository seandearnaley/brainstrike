/**
 * Argument decoders for the handwritten `secrets:*` IPC handlers in
 * `ipc-secrets.ts` (docs/agents/effect-boundary.md § "Schema at boundaries").
 *
 * Main-only by construction: only `ipc-secrets.ts` imports this module, and no
 * preload reaches it, so importing `effect` here keeps the preload import graph
 * free of bare packages. Like a contract domain's `parseArgs`, a malformed
 * argument list throws: the arity is exact and the provider id is checked
 * before it can key the secrets store. The credential payload of
 * `saveCredential` stays `unknown` here on purpose; `setCredential`'s guard is
 * its single validator.
 */
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

const MAX_PROVIDER_ID_LENGTH = 256;
const PROVIDER_ID_MESSAGE =
  `secrets IPC provider must be a non-empty string of at most ${MAX_PROVIDER_ID_LENGTH} ` +
  'characters with no control characters.';

function isPrintableProviderId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PROVIDER_ID_LENGTH) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

const providerId = Schema.String.annotate({ message: PROVIDER_ID_MESSAGE }).check(
  Schema.makeFilter(isPrintableProviderId, { message: PROVIDER_ID_MESSAGE })
);

const secretValue = Schema.String.annotate({ message: 'secrets IPC value must be a string.' });

/** `secrets:get`, `secrets:getCredential`, `secrets:delete`: `(provider)`. */
export const decodeProviderArgs = makeThrowingDecoder(Schema.Tuple([providerId]));

/** `secrets:save`: `(provider, value)`. */
export const decodeProviderValueArgs = makeThrowingDecoder(Schema.Tuple([providerId, secretValue]));

/** `secrets:saveCredential`: `(provider, credential)`; the credential is validated downstream. */
export const decodeProviderCredentialArgs = makeThrowingDecoder(
  Schema.Tuple([providerId, Schema.Unknown])
);
