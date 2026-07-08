/**
 * @module pipeline/identifiers
 *
 * ID generation and dedupe key utilities for the indexing pipeline.
 *
 * This module provides the canonical implementations for generating
 * unique identifiers and deduplication keys used throughout the pipeline.
 */

import { generateContentHash, generateUUID } from '@brainstrike/utils';
import type { ChunkId, ContentHash, EmbeddingSetId, FileId, JobId } from './types.js';

// =============================================================================
// ID GENERATORS
// =============================================================================

/**
 * Generate a new file record ID.
 */
export function generateFileId(): FileId {
  return generateUUID() as FileId;
}

/**
 * Generate a new chunk ID.
 */
export function generateChunkId(): ChunkId {
  return generateUUID() as ChunkId;
}

/**
 * Generate a new embedding set ID.
 */
export function generateEmbeddingSetId(): EmbeddingSetId {
  return generateUUID() as EmbeddingSetId;
}

/**
 * Generate a new job ID.
 */
export function generateJobId(): JobId {
  return generateUUID() as JobId;
}

// =============================================================================
// CONTENT HASH UTILITIES
// =============================================================================

/**
 * Generate a content hash for deduplication.
 * Uses SHA-256 for consistent hashing.
 */
export async function generateHash(content: string): Promise<ContentHash> {
  return (await generateContentHash(content)) as ContentHash;
}

/**
 * Synchronous content hash for small strings (< 1KB).
 * Uses a simple but consistent hash algorithm.
 */
export function generateHashSync(content: string): ContentHash {
  // Simple FNV-1a hash for small content
  let hash = 2_166_136_261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  // Convert to hex string
  const result = (hash >>> 0).toString(16).padStart(8, '0');
  return result as ContentHash;
}

// =============================================================================
// DEDUPE KEY BUILDERS
// =============================================================================

const DEFAULT_SET_PLACEHOLDER = '__default__';

/**
 * Build a dedupe key for file records.
 * Format: `file:{contentHash}:{embeddingSetId}`
 *
 * @param contentHash - SHA-256 hash of file content
 * @param embeddingSetId - Target embedding set (optional)
 */
export function buildFileDedupeKey(contentHash: string, embeddingSetId?: string | null): string {
  const normalizedHash = contentHash || '';
  const normalizedSet = embeddingSetId?.trim() || DEFAULT_SET_PLACEHOLDER;
  return `file:${normalizedHash}:${normalizedSet}`;
}

/**
 * Build a dedupe key for chunks.
 * Format: `chunk:{fileId}:{chunkIndex}`
 *
 * @param fileId - Parent file record ID
 * @param chunkIndex - Zero-based chunk index
 */
export function buildChunkDedupeKey(fileId: string, chunkIndex: number): string {
  return `chunk:${fileId}:${chunkIndex}`;
}

/**
 * Build a dedupe key for embedding jobs.
 * Format: `embed:{chunkId}:{embeddingSetId}:{modelKey}`
 *
 * This ensures embedding jobs are idempotent - re-enqueuing
 * the same chunk+set+model combination returns the existing job.
 *
 * @param chunkId - Chunk ID to embed
 * @param embeddingSetId - Target embedding set
 * @param modelKey - Embedding model identifier
 */
export function buildEmbedJobDedupeKey(
  chunkId: string,
  embeddingSetId: string,
  modelKey: string
): string {
  return `embed:${chunkId}:${embeddingSetId}:${modelKey}`;
}

/**
 * Parse a dedupe key into its components.
 * Returns null if the key format is unrecognized.
 */
export function parseDedupeKey(key: string): ParsedDedupeKey | null {
  const parts = key.split(':');
  if (parts.length < 2) {
    return null;
  }

  const [type, ...rest] = parts;

  switch (type) {
    case 'file': {
      if (rest.length < 2) {
        return null;
      }
      const [contentHash, embeddingSetId] = rest;
      return {
        contentHash: contentHash as ContentHash,
        embeddingSetId:
          embeddingSetId === DEFAULT_SET_PLACEHOLDER ? null : (embeddingSetId as EmbeddingSetId),
        type: 'file',
      };
    }
    case 'chunk': {
      if (rest.length < 2) {
        return null;
      }
      const [fileId, chunkIndexStr] = rest;
      const chunkIndex = Number.parseInt(chunkIndexStr ?? '', 10);
      if (!Number.isFinite(chunkIndex)) {
        return null;
      }
      return {
        chunkIndex,
        fileId: fileId as FileId,
        type: 'chunk',
      };
    }
    case 'embed': {
      if (rest.length < 3) {
        return null;
      }
      const [chunkId, embeddingSetId, modelKey] = rest;
      return {
        chunkId: chunkId as ChunkId,
        embeddingSetId: embeddingSetId as EmbeddingSetId,
        modelKey: modelKey ?? '',
        type: 'embed',
      };
    }
    default:
      return null;
  }
}

/**
 * Parsed dedupe key discriminated union.
 */
export type ParsedDedupeKey =
  | { type: 'file'; contentHash: ContentHash; embeddingSetId: EmbeddingSetId | null }
  | { type: 'chunk'; fileId: FileId; chunkIndex: number }
  | { type: 'embed'; chunkId: ChunkId; embeddingSetId: EmbeddingSetId; modelKey: string };

// =============================================================================
// VALIDATION UTILITIES
// =============================================================================

/**
 * Validate a UUID string format.
 * Returns true if the string looks like a valid UUID v4.
 */
export function isValidUUID(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Validate a content hash format.
 * Returns true if the string looks like a valid SHA-256 hash.
 */
export function isValidContentHash(value: string): boolean {
  // SHA-256 is 64 hex characters
  const sha256Regex = /^[0-9a-f]{64}$/i;
  return sha256Regex.test(value);
}

/**
 * Cast a string to FileId with validation.
 * Throws if the string is not a valid UUID.
 */
export function toFileId(value: string): FileId {
  if (!isValidUUID(value)) {
    throw new Error(`Invalid FileId: ${value}`);
  }
  return value as FileId;
}

/**
 * Cast a string to ChunkId with validation.
 * Throws if the string is not a valid UUID.
 */
export function toChunkId(value: string): ChunkId {
  if (!isValidUUID(value)) {
    throw new Error(`Invalid ChunkId: ${value}`);
  }
  return value as ChunkId;
}

/**
 * Cast a string to EmbeddingSetId with validation.
 * Throws if the string is not a valid UUID.
 */
export function toEmbeddingSetId(value: string): EmbeddingSetId {
  if (!isValidUUID(value)) {
    throw new Error(`Invalid EmbeddingSetId: ${value}`);
  }
  return value as EmbeddingSetId;
}

/**
 * Cast a string to ContentHash without validation.
 * Used for hashes generated by external systems.
 */
export function toContentHash(value: string): ContentHash {
  return value as ContentHash;
}
