import { treeSitterAdapter } from './parsers/tree-sitter-adapter.ts';
import type { ParserAdapter } from './parsers/types.ts';
import { chunkContent, type PortableChunkingResult } from './portable-chunking.ts';
import type { ChunkingRequestOptions } from './shared';

export type { ChunkSkipCode, PortableChunkingResult } from './portable-chunking.ts';
export type { ChunkingRequestOptions, PortableChunk } from './shared';

/** Canonical chunking as the ingestion host calls it: one file's content to its chunks. */
export type CanonicalChunker = (
  content: string,
  options: ChunkingRequestOptions & { fileName?: string; filePath?: string }
) => Promise<PortableChunkingResult>;

/**
 * The canonical algorithm with `codeAdapter` parsing code. Python always
 * parses with the vendored tree-sitter grammar: canonical chunking has no
 * configuration in which it claims Python but has no parser for it (BST-1983).
 */
export function canonicalChunker(codeAdapter: ParserAdapter): CanonicalChunker {
  const pythonAdapter = treeSitterAdapter('python');
  return (content, options) =>
    chunkContent(content, options, {
      selectAdapter: (fileName) => (/\.pyi?$/iu.test(fileName ?? '') ? pythonAdapter : codeAdapter),
      strict: true,
    });
}
