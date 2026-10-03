/** Reuse an already owned read-only connection; this entrypoint constructs no SQLite engine. */

export type { EmbeddingState, IndexerIdentity } from './contracts.js';
export { identityStateSchema } from './contracts.js';
export { decodeIndexIdentityRow, readIndexIdentity } from './index-metadata.js';
