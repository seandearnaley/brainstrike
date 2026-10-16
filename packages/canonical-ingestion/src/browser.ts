/**
 * Canonical ingestion for a host that brings its own source, catalog,
 * publication and inference ports: the browser's index worker (BST-1940).
 * The workspace runtime and its mounted-lease source stay on the Node entry.
 * Nothing reachable from here imports a Node module statically;
 * `browser-entry.test.ts` holds that.
 */

export {
  createNativeCanonicalCatalog,
  decodeNativeCanonicalCatalogRecords,
  type NativeCanonicalCatalogDependencies,
  type NativeCanonicalCatalogRecord,
  type NativeCanonicalCatalogScope,
} from './canonical-catalog.js';
export {
  type CanonicalIngestionDependencies,
  CanonicalIngestionHost,
  CanonicalScanIncompleteError,
} from './host.js';
export * from './ports.js';
export { createNativeScanAdmission } from './scan-admission.js';
export {
  createNativeCanonicalPublication,
  type NativeAcknowledgedPublication,
  type NativeScopeReadiness,
} from './scoped-publication.js';
