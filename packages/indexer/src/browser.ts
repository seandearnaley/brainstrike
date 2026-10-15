/**
 * The derived index for a host that opens its own connection: the browser
 * writer (BST-1940), on sqlite-wasm with the binary vector engine. Nothing
 * reachable from here imports a Node module; `browser-entry.test.ts` holds that.
 */
export { BINARY_VECTOR_ENGINE_VERSION, binaryVectorEngine } from './binary-vector-engine.js';
export type { IndexConnection, IndexReaderConnection } from './index-connection.js';
export { IndexReader, IndexWriter } from './store.js';
export type { CoarseVectorEngine } from './vector-engine.js';
