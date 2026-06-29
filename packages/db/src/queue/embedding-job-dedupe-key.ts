export const EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT = 'none';

export function buildEmbeddingJobDedupeKey(
  chunkId: string,
  embeddingSetId: string | null | undefined,
  contentHash: string
): string {
  return `${chunkId}:${embeddingSetId ?? EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT}:${contentHash}`;
}
