export interface BackgroundBackfillProgress {
  current: number;
  total: number;
}

export interface BackgroundBackfillSnapshot {
  embeddingSetId: string;
  progress: BackgroundBackfillProgress | null;
  requestId: string;
}

export interface EmbeddingCoverageSnapshot {
  chunksWithEmbeddingsForSet: number;
  totalChunks: number;
}

const BACKGROUND_INDEXING_BACKFILL_PREFIX = 'background-indexing-backfill:';

export function isBackgroundIndexingBackfillRequestId(requestId: string): boolean {
  return requestId.startsWith(BACKGROUND_INDEXING_BACKFILL_PREFIX);
}

export function selectRecoverableBackgroundBackfill(args: {
  embeddingSetId: string;
  inFlightBackfills: readonly BackgroundBackfillSnapshot[];
}): BackgroundBackfillSnapshot | null {
  return (
    args.inFlightBackfills.find(
      (backfill) =>
        backfill.embeddingSetId === args.embeddingSetId &&
        isBackgroundIndexingBackfillRequestId(backfill.requestId)
    ) ?? null
  );
}

export function getSupersededBackgroundBackfillIds(args: {
  exceptEmbeddingSetId?: string;
  inFlightBackfills: readonly BackgroundBackfillSnapshot[];
}): string[] {
  const supersededIds: string[] = [];
  for (const backfill of args.inFlightBackfills) {
    if (!isBackgroundIndexingBackfillRequestId(backfill.requestId)) {
      continue;
    }
    if (backfill.embeddingSetId === args.exceptEmbeddingSetId) {
      continue;
    }
    supersededIds.push(backfill.embeddingSetId);
  }
  return supersededIds;
}

export function needsEmbeddingBackfill(coverage: EmbeddingCoverageSnapshot): boolean {
  return coverage.totalChunks > 0 && coverage.chunksWithEmbeddingsForSet < coverage.totalChunks;
}
