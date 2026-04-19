/**
 * Context Packer Utilities (BST-173)
 *
 * Transforms semantic search results into ContextPackerChunk format
 * for token-budget-aware packing.
 */

import type { ContextPackerChunk } from '@brainstrike/agent/context-packer';
import type { SemanticSearchResult } from '@brainstrike/ui';

/**
 * Token count lookup function type.
 * Returns the token count for a given content string, or undefined if not available.
 */
export type TokenCountLookup = (content: string) => number | undefined;

/**
 * Convert SemanticSearchResult to ContextPackerChunk format.
 *
 * This bridges the web UI's search result format to the agent's context packer input.
 */
export function toContextPackerChunk(
  result: SemanticSearchResult,
  index: number,
  tokenCountLookup?: TokenCountLookup
): ContextPackerChunk {
  const tokenCount = tokenCountLookup?.(result.content);

  const chunk: ContextPackerChunk = {
    id: result.chunkId,
    content: result.content,
    score: result.similarity,
  };

  // Add optional fields only if present
  if (tokenCount !== undefined) {
    chunk.tokenCount = tokenCount;
  }
  if (result.filePath) {
    chunk.filePath = result.filePath;
  }
  if (result.fileName) {
    chunk.fileName = result.fileName;
  }

  // Store additional metadata for citation/reference purposes
  chunk.metadata = {
    fileRecordId: result.fileRecordId,
    nodeId: result.nodeId,
    rank: index + 1,
    ...(result.embeddingSetId ? { embeddingSetId: result.embeddingSetId } : {}),
  };

  return chunk;
}

/**
 * Convert an array of SemanticSearchResult to ContextPackerChunk[].
 */
export function toContextPackerChunks(
  results: readonly SemanticSearchResult[],
  tokenCountLookup?: TokenCountLookup
): ContextPackerChunk[] {
  return results.map((result, index) => toContextPackerChunk(result, index, tokenCountLookup));
}

/**
 * Format packed chunks into a readable context string with source citations.
 *
 * This mirrors the desktop's formatContext function for consistent output.
 */
export function formatPackedContext(
  chunks: readonly { content: string; filePath?: string; fileName?: string; chunkIndex?: number }[]
): string {
  if (chunks.length === 0) {
    return '';
  }

  return chunks
    .map((chunk, index) => {
      const location = chunk.filePath ?? chunk.fileName ?? 'Unknown file';
      const chunkLabel = chunk.chunkIndex === undefined ? '' : ` (chunk ${chunk.chunkIndex})`;
      return `Source ${index + 1}: ${location}${chunkLabel}\n${chunk.content}`;
    })
    .join('\n\n---\n\n');
}
