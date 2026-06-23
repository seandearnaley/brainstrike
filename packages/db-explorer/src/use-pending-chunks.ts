import type { DbHandle } from '@brainstrike/db';
import { isAppActive } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useRef, useState } from 'react';

interface PendingRow {
  dedupeKey: string | null;
}

function derivePendingChunkIds(rows: PendingRow[], activeSetId: string): Set<string> {
  return rows.reduce((ids, row) => {
    const [chunkId, setId] = (row.dedupeKey ?? '').split(':');
    if (chunkId && setId === activeSetId) {
      ids.add(chunkId);
    }
    return ids;
  }, new Set<string>());
}

export interface UsePendingChunksOptions {
  database: DbHandle | null;
  intervalMs?: number;
  resolveActiveSetId?: () => string | null | undefined;
}

export interface UsePendingChunksResult {
  pendingChunkIds: Set<string>;
  refreshPendingChunks: () => Promise<void>;
}

const logger = createLogger('usePendingChunks');

export function usePendingChunks({
  database,
  resolveActiveSetId,
  intervalMs = 2000,
}: UsePendingChunksOptions): UsePendingChunksResult {
  const [pendingChunkIds, setPendingChunkIds] = useState<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const resetPendingChunks = useCallback(() => {
    if (isMountedRef.current) {
      setPendingChunkIds(new Set<string>());
    }
  }, []);

  const fetchPending = useCallback(async () => {
    if (!database) {
      resetPendingChunks();
      return;
    }

    const activeSetId = resolveActiveSetId?.() ?? null;
    if (!activeSetId) {
      resetPendingChunks();
      return;
    }

    try {
      const res = await database.query<PendingRow>(
        "SELECT dedupe_key AS \"dedupeKey\" FROM job_queue WHERE queue = 'embeddings' AND state IN ('queued','running')"
      );
      if (!isMountedRef.current) {
        return;
      }

      const ids = derivePendingChunkIds(res.rows, activeSetId);
      setPendingChunkIds(ids);
    } catch (error) {
      logger.debug('Failed to fetch pending chunks', { error });
    }
  }, [database, resolveActiveSetId, resetPendingChunks]);

  useEffect(() => {
    if (!database) {
      setPendingChunkIds(new Set<string>());
      return;
    }

    let canceled = false;

    const runFetch = async () => {
      if (canceled) {
        return;
      }
      await fetchPending();
    };

    void runFetch();

    if (intervalMs === null || intervalMs <= 0) {
      return () => {
        canceled = true;
      };
    }

    const id = window.setInterval(() => {
      if (!isAppActive()) {
        return;
      }
      void runFetch();
    }, intervalMs);
    return () => {
      canceled = true;
      window.clearInterval(id);
    };
  }, [database, fetchPending, intervalMs]);

  const refreshPendingChunks = useCallback(async () => {
    await fetchPending();
  }, [fetchPending]);

  return { pendingChunkIds, refreshPendingChunks };
}
