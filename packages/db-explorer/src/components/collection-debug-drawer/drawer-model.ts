/**
 * Pure derivations for the collection debug drawer.
 *
 * Kept free of React and of the DB layer so the drawer's semantics (what
 * counts as "failed", when retrieval is refused, how a score reads aloud) are
 * testable in isolation — and so deleting the drawer deletes them with it.
 */

import type { EmbeddingStatus } from '@brainstrike/ui';

/** Durable system role of a collection, as recorded on the embedding set. */
export type CollectionSystemRole = 'workspace-index' | null | undefined;

export interface FileEmbeddingCounts {
  /** Total chunks materialized for the file. */
  chunksCount: number;
  /** Whether the chunking pass has finished for this file. */
  chunksProcessed: boolean;
  /** Chunks that already carry an embedding vector. */
  embeddedChunksCount: number;
  /** Chunks the embedding queue recorded as failed, when known. */
  failedChunksCount?: number;
}

/**
 * Derive a display status for a file from the counts the drawer's queries
 * project. There is no stored per-file status column — embedding state is
 * derived everywhere in this codebase — so this is the single place the
 * drawer decides what those counts mean.
 */
export function deriveFileEmbeddingStatus(counts: FileEmbeddingCounts): EmbeddingStatus {
  if ((counts.failedChunksCount ?? 0) > 0) {
    return 'failed';
  }
  if (counts.chunksCount === 0) {
    // No chunks yet: still pending if the chunking pass has not run, otherwise
    // the file genuinely has nothing to embed.
    return counts.chunksProcessed ? 'none' : 'pending';
  }
  if (counts.embeddedChunksCount === 0) {
    return 'pending';
  }
  if (counts.embeddedChunksCount >= counts.chunksCount) {
    return 'complete';
  }
  return 'processing';
}

export function deriveChunkEmbeddingStatus(chunk: {
  failed?: boolean;
  hasEmbedding: boolean;
}): EmbeddingStatus {
  if (chunk.failed) {
    return 'failed';
  }
  return chunk.hasEmbedding ? 'complete' : 'pending';
}

/**
 * Same rule the retired Collection Browser enforced: a workspace-index set is
 * system-managed and is never a normal search target.
 */
export function canUseCollectionForRetrievalPreview(
  activeCollectionId: string | null,
  activeCollectionSystemRole: CollectionSystemRole
): activeCollectionId is string {
  return activeCollectionId !== null && activeCollectionSystemRole !== 'workspace-index';
}

/**
 * The refusal reason, always non-empty while refusing. The drawer renders this
 * verbatim — a refused preview must say why, never just go quiet.
 */
export function getRetrievalDisabledReason(
  activeCollectionId: string | null,
  activeCollectionSystemRole: CollectionSystemRole
): string | null {
  if (activeCollectionId === null) {
    return 'Select a collection to run a retrieval preview.';
  }
  if (activeCollectionSystemRole === 'workspace-index') {
    return 'Workspace Index is system-managed and cannot be used for a collection retrieval preview. Use Explorer → Search instead.';
  }
  return null;
}

export interface FormattedScore {
  /** Compact visual label. */
  label: string;
  /** Spoken/assistive equivalent, including the raw score. */
  textEquivalent: string;
}

/**
 * Format a 0-1 similarity (or normalized RRF) score. Scores are the affordance
 * Workspace Search deliberately lacks, so they always get a text equivalent.
 */
export function formatSimilarityScore(score: number): FormattedScore {
  const safe = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  const percent = (safe * 100).toFixed(2);
  return {
    label: `${percent}%`,
    // Both readings derive from the SAME clamped value. Reporting the raw
    // `score` here let a non-finite input render "0.00%" visually while
    // announcing "(NaN)" to a screen reader.
    textEquivalent: `Score ${percent} percent (${Number(safe.toFixed(4))})`,
  };
}
