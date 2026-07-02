import {
  makeLiveQueryKey,
  useBrainstrikeLiveQuery,
  useBrainstrikeLiveQueryCapability,
  useFileChunkRepository,
} from '@brainstrike/db';
import { useEffect, useMemo, useState } from 'react';

export type CollectionEmbeddingCoverageStatus =
  | 'idle'
  | 'fully_indexed'
  | 'needs_reindex'
  | 'partial_source_ranges';

export interface CollectionEmbeddingCoverageSnapshot {
  chunksMissingSourceRange: number;
  pendingReindexFileCount: number;
  status: CollectionEmbeddingCoverageStatus;
  totalChunks: number;
  totalFiles: number;
}

interface CollectionCoverageRow {
  chunksmissing: number;
  embeddingsetid: string;
  pendingreindexfiles: number;
  totalchunks: number;
  totalfiles: number;
}

type CollectionCoverageRepositorySnapshot = Omit<CollectionEmbeddingCoverageSnapshot, 'status'>;

interface CollectionCoverageRepository {
  getCollectionEmbeddingCoverage: (
    embeddingSetId: string
  ) => Promise<CollectionCoverageRepositorySnapshot>;
}

const COLLECTION_EMBEDDING_COVERAGE_QUERY = `
  WITH target AS (SELECT $1::text AS embedding_set_id)
  SELECT
    target.embedding_set_id AS embeddingsetid,
    COUNT(DISTINCT fr.id)::int AS totalfiles,
    COUNT(fc.id)::int AS totalchunks,
    COUNT(DISTINCT fr.id) FILTER (WHERE fr.chunks_processed_at IS NULL)::int AS pendingreindexfiles,
    COUNT(fc.id) FILTER (
      WHERE fc.start_line IS NULL
         OR fc.end_line IS NULL
         OR fc.start_offset IS NULL
         OR fc.end_offset IS NULL
    )::int AS chunksmissing
  FROM file_records fr
  LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
  JOIN target ON fr.embedding_set_id = target.embedding_set_id
  GROUP BY target.embedding_set_id
`.trim();

function isValidCoverageRow(row: unknown): row is CollectionCoverageRow {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const record = row as Record<string, unknown>;
  return (
    typeof record['embeddingsetid'] === 'string' &&
    typeof record['totalfiles'] === 'number' &&
    typeof record['totalchunks'] === 'number' &&
    typeof record['pendingreindexfiles'] === 'number' &&
    typeof record['chunksmissing'] === 'number'
  );
}

export function resolveCoverageStatus(
  totalFiles: number,
  pendingReindexFileCount: number,
  chunksMissingSourceRange: number
): CollectionEmbeddingCoverageStatus {
  if (totalFiles === 0) {
    return 'idle';
  }
  if (pendingReindexFileCount > 0) {
    return 'needs_reindex';
  }
  if (chunksMissingSourceRange > 0) {
    return 'partial_source_ranges';
  }
  return 'fully_indexed';
}

function mapRowToSnapshot(row: CollectionCoverageRow): CollectionEmbeddingCoverageSnapshot {
  const pendingReindexFileCount = row.pendingreindexfiles;
  const chunksMissingSourceRange = row.chunksmissing;
  const totalFiles = row.totalfiles;
  const totalChunks = row.totalchunks;
  return {
    pendingReindexFileCount,
    chunksMissingSourceRange,
    totalFiles,
    totalChunks,
    status: resolveCoverageStatus(totalFiles, pendingReindexFileCount, chunksMissingSourceRange),
  };
}

const IDLE_SNAPSHOT: CollectionEmbeddingCoverageSnapshot = {
  pendingReindexFileCount: 0,
  chunksMissingSourceRange: 0,
  totalFiles: 0,
  totalChunks: 0,
  status: 'idle',
};

export function useCollectionEmbeddingCoverage(activeCollectionId: string | null) {
  const liveQueryAvailable = useBrainstrikeLiveQueryCapability();
  const chunkRepository = useFileChunkRepository();
  const params = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? ([activeCollectionId] as const) : undefined),
    [activeCollectionId]
  );
  const liveQueryEnabled = Boolean(activeCollectionId) && liveQueryAvailable;
  const repositoryCoverageLoader = useMemo(() => {
    if (
      liveQueryAvailable ||
      !chunkRepository ||
      typeof (chunkRepository as Partial<CollectionCoverageRepository>)
        .getCollectionEmbeddingCoverage !== 'function'
    ) {
      return null;
    }
    return (chunkRepository as CollectionCoverageRepository).getCollectionEmbeddingCoverage.bind(
      chunkRepository
    );
  }, [chunkRepository, liveQueryAvailable]);
  const [repositorySnapshot, setRepositorySnapshot] = useState<{
    collectionId: string;
    snapshot: CollectionEmbeddingCoverageSnapshot;
  } | null>(null);
  const [repositoryError, setRepositoryError] = useState<Error | null>(null);
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const [repositoryRefreshVersion, setRepositoryRefreshVersion] = useState(0);

  const { rows, error, loading } = useBrainstrikeLiveQuery<CollectionCoverageRow>({
    cacheKey: makeLiveQueryKey('collection-embedding-coverage', activeCollectionId),
    query: COLLECTION_EMBEDDING_COVERAGE_QUERY,
    ...(params ? { params } : {}),
    mode: 'incremental',
    key: 'embeddingsetid',
    enabled: liveQueryEnabled,
  });

  useEffect(() => {
    if (!(activeCollectionId && !liveQueryEnabled)) {
      setRepositoryLoading(false);
      setRepositoryError(null);
      return;
    }
    if (!repositoryCoverageLoader) {
      setRepositorySnapshot(null);
      setRepositoryLoading(false);
      setRepositoryError(
        new Error('Collection embedding coverage requires repository snapshot support.')
      );
      return;
    }

    let cancelled = false;
    setRepositoryLoading(true);
    setRepositoryError(null);
    repositoryCoverageLoader(activeCollectionId)
      .then((coverage) => {
        if (cancelled) {
          return;
        }
        setRepositorySnapshot({
          collectionId: activeCollectionId,
          snapshot: {
            ...coverage,
            status: resolveCoverageStatus(
              coverage.totalFiles,
              coverage.pendingReindexFileCount,
              coverage.chunksMissingSourceRange
            ),
          },
        });
        setRepositoryLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setRepositorySnapshot(null);
        setRepositoryError(
          loadError instanceof Error
            ? loadError
            : new Error('Failed to load collection embedding coverage from repository.')
        );
        setRepositoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCollectionId, liveQueryEnabled, repositoryCoverageLoader, repositoryRefreshVersion]);

  useEffect(() => {
    if (typeof window === 'undefined' || !activeCollectionId) {
      return;
    }

    const handleQueueDrained = (event: Event) => {
      const detail = (event as CustomEvent<{ embeddingSetId?: string | null } | undefined>).detail;
      if (detail?.embeddingSetId && detail.embeddingSetId !== activeCollectionId) {
        return;
      }
      if (!liveQueryEnabled && repositoryCoverageLoader) {
        setRepositoryRefreshVersion((version) => version + 1);
      }
    };

    window.addEventListener('brainstrike:queue-drained', handleQueueDrained);
    return () => {
      window.removeEventListener('brainstrike:queue-drained', handleQueueDrained);
    };
  }, [activeCollectionId, liveQueryEnabled, repositoryCoverageLoader]);

  const snapshot = useMemo(() => {
    if (!activeCollectionId) {
      return IDLE_SNAPSHOT;
    }
    if (!liveQueryEnabled) {
      return repositorySnapshot?.collectionId === activeCollectionId
        ? repositorySnapshot.snapshot
        : IDLE_SNAPSHOT;
    }
    const row = rows[0];
    if (!(row && isValidCoverageRow(row) && row.embeddingsetid === activeCollectionId)) {
      return IDLE_SNAPSHOT;
    }
    return mapRowToSnapshot(row);
  }, [activeCollectionId, liveQueryEnabled, repositorySnapshot, rows]);

  return {
    snapshot,
    error: liveQueryEnabled ? error : repositoryError,
    loading: liveQueryEnabled ? loading : repositoryLoading,
  };
}
