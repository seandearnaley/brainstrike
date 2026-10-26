/** Reuse an already owned read-only connection; this entrypoint constructs no SQLite engine. */

export type { IndexerIdentity } from './contracts.ts';
export { identityStateSchema } from './contracts.ts';
export { decodeIndexIdentityRow, readIndexIdentity } from './index-metadata.ts';
