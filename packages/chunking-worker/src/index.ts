/**
 * @brainstrike/chunking-worker
 *
 * Executes the canonical chunking algorithm (AST-aware code splitting and token
 * counting) for `@brainstrike/chunking-worker/node`.
 */

export type { CodeLanguage } from './chunking-config';

// Re-export chunking config for consumers
export { CHUNKING_CONFIG } from './chunking-config';
export type {
  ExtractedSymbols,
  PortableSymbol,
  PortableSymbolKind,
  PortableSymbolRef,
  PortableSymbolRefKind,
} from './extract-symbols';
// Re-export tree-sitter rollout bootstrap helper for app renderers.
// Apps call this at startup and assign the result to
// globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ (Phase 8 of #998).
export { resolveBootstrapTreeSitterLanguages } from './parsers/tree-sitter-rollout';
export type { ChunkSkipCode, PortableChunkingResult } from './portable-chunking';
// Re-export portable chunking for direct usage (if needed outside worker)
export { chunkContent } from './portable-chunking';
// Re-export shared types
export type {
  ChunkBatchRequest,
  ChunkError,
  ChunkingRequestOptions,
  ChunkingStrategy,
  ChunkProgress,
  ChunkRequest,
  ChunkResult,
  ChunkType,
  PortableChunk,
  WorkerLog,
  WorkerReady,
  WorkerRequest,
  WorkerResponse,
} from './shared';
