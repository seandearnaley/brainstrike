export const EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT = 'none';
export const EMBEDDING_JOB_DEDUPE_KEY_DELIMITER = ':';

export interface EmbeddingJobDedupeKeySqlExpressionOptions {
  readonly chunkIdExpression: string;
  readonly contentHashExpression: string;
  readonly embeddingSetIdExpression: string;
}

export function buildEmbeddingJobDedupeKey(
  chunkId: string,
  embeddingSetId: string | null | undefined,
  contentHash: string
): string {
  return [chunkId, embeddingSetId ?? EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT, contentHash].join(
    EMBEDDING_JOB_DEDUPE_KEY_DELIMITER
  );
}

export function buildEmbeddingJobDedupeKeySqlExpression({
  chunkIdExpression,
  contentHashExpression,
  embeddingSetIdExpression,
}: EmbeddingJobDedupeKeySqlExpressionOptions): string {
  return `(${chunkIdExpression} || '${EMBEDDING_JOB_DEDUPE_KEY_DELIMITER}' || ${embeddingSetIdExpression} || '${EMBEDDING_JOB_DEDUPE_KEY_DELIMITER}' || ${contentHashExpression})`;
}
