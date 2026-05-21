import type { IDatabase } from '@brainstrike/db';
import { markCollectionIndexingStatsDirty, refreshCollectionIndexingStats } from '@brainstrike/db';

export type StatsRefreshReason = 'interval' | 'queue-idle' | 'threshold' | 'worker-stop';

export interface EmbeddingStatsRefreshControllerOptions {
  completedChunkThreshold: number;
  db: IDatabase;
  log: (msg: string, meta?: unknown) => void;
  minIntervalMs: number;
  now: () => number;
}

export interface EmbeddingStatsRefreshController {
  flush: (reason: StatsRefreshReason) => Promise<void>;
  flushIfDue: () => Promise<void>;
  recordCompletions: (
    embeddingSetIds: readonly string[],
    completedChunkCount: number
  ) => Promise<void>;
}

export function createEmbeddingStatsRefreshController({
  completedChunkThreshold,
  db,
  log,
  minIntervalMs,
  now,
}: EmbeddingStatsRefreshControllerOptions): EmbeddingStatsRefreshController {
  const pendingEmbeddingSetIds = new Set<string>();
  let completedSinceRefresh = 0;
  let lastRefreshAt = now();
  let flushInFlight: Promise<void> | null = null;

  const flushPending = async (reason: StatsRefreshReason): Promise<void> => {
    if (pendingEmbeddingSetIds.size === 0) {
      return;
    }

    const embeddingSetIds = [...pendingEmbeddingSetIds];
    const completedChunkCount = completedSinceRefresh;
    const startedAt = now();
    pendingEmbeddingSetIds.clear();
    completedSinceRefresh = 0;

    try {
      await refreshCollectionIndexingStats(db, embeddingSetIds, {
        label: 'embedding stats refresh',
        priority: 'background',
      });
      lastRefreshAt = now();
      log('embedding_stats_refresh', {
        completedChunkCount,
        durationMs: Math.round(now() - startedAt),
        embeddingSetCount: embeddingSetIds.length,
        reason,
      });
    } catch (error) {
      for (const embeddingSetId of embeddingSetIds) {
        pendingEmbeddingSetIds.add(embeddingSetId);
      }
      completedSinceRefresh += completedChunkCount;
      throw error;
    }
  };

  const flush = async (reason: StatsRefreshReason): Promise<void> => {
    while (flushInFlight) {
      try {
        await flushInFlight;
      } catch {
        // The in-flight flush restored pending state before rejecting; this caller can retry it.
      }
    }
    const nextFlush = flushPending(reason);
    flushInFlight = nextFlush;
    try {
      await nextFlush;
    } finally {
      if (flushInFlight === nextFlush) {
        flushInFlight = null;
      }
    }
  };

  return {
    flush,
    flushIfDue: async () => {
      if (pendingEmbeddingSetIds.size === 0) {
        return;
      }
      if (completedSinceRefresh >= completedChunkThreshold) {
        await flush('threshold');
        return;
      }
      if (now() - lastRefreshAt >= minIntervalMs) {
        await flush('interval');
      }
    },
    recordCompletions: async (embeddingSetIds, completedChunkCount) => {
      if (embeddingSetIds.length === 0 || completedChunkCount <= 0) {
        return;
      }
      const uniqueIds = [...new Set(embeddingSetIds)];
      const newlyPendingIds = uniqueIds.filter(
        (embeddingSetId) => !pendingEmbeddingSetIds.has(embeddingSetId)
      );
      for (const embeddingSetId of newlyPendingIds) {
        pendingEmbeddingSetIds.add(embeddingSetId);
      }
      completedSinceRefresh += completedChunkCount;
      if (newlyPendingIds.length > 0) {
        await markCollectionIndexingStatsDirty(db, newlyPendingIds, {
          label: 'embedding completion stats dirty',
          priority: 'background',
        });
      }
    },
  };
}
