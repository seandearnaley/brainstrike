/**
 * Canonical ingestion for the browser's index worker (BST-1940): the host,
 * and the workspace runtime and source over a lease the worker brings, its
 * File System Access handles.
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
export {
  CanonicalWorkspaceIngestionRuntime,
  type CanonicalWorkspaceRuntimeDependencies,
} from './workspace-runtime.js';
export { CanonicalWorkspaceSource } from './workspace-source.js';
export * from './workspace-source-ports.js';
