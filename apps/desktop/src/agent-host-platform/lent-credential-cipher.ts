import type { CredentialCipher } from '@brainstrike/agent-host/credential-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';

const decodeText = wireDecoder(Schema.String, { errors: 'all', onExcessProperty: 'error' });

/** ADR-0029: the host borrows Main's safeStorage over its platform connection. */
export function lentCredentialCipher(
  request: (method: string, input: unknown) => Promise<unknown>
): CredentialCipher {
  return {
    open: async (sealed) => decodeText(await request('platform/credentials/open', { sealed })),
    seal: async (plaintext) =>
      decodeText(await request('platform/credentials/seal', { plaintext })),
  };
}
