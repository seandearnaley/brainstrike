export { createNodeChunker, type NodeChunkerOptions } from '@brainstrike/chunking-worker/node';
export {
  type CanonicalIngestionDependencies,
  CanonicalIngestionHost,
  CanonicalScanIncompleteError,
} from './host.js';
export * from './ports.js';
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
