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
export type { ChunkSkipCode, PortableChunkingResult } from './portable-chunking';
// Re-export portable chunking for direct usage
export { chunkContent } from './portable-chunking';
// Re-export shared types
export type {
  ChunkingRequestOptions,
  ChunkingStrategy,
  ChunkResult,
  ChunkType,
  PortableChunk,
} from './shared';
