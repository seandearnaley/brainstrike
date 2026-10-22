/**
 * The derived index for a host that opens its own connection. Nothing
 * reachable from here imports a Node module; `browser-entry.test.ts` holds that.
 */
export type {
  ScopedCoverage,
  ScopedFilePlan,
  ScopedManifestFile,
  ScopedManifestResult,
  VectorProfile,
} from './contracts.js';
export { IndexerError } from './contracts.js';
export type { IndexConnection, IndexReaderConnection } from './index-connection.js';
export { vectorProfileHash } from './scope-authority.js';
export {
  SCOPED_INDEX_OPERATIONS,
  type ScopedIndexOperation,
  scopedIndexOperations,
} from './scoped-operations.js';
export { createStateProjection, type StateProjection } from './state-producer.js';
export { IndexReader, IndexWriter } from './store.js';
export type { CoarseVectorEngine } from './vector-engine.js';
