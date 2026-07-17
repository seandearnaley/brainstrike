import type { WorkspaceCollectionSyncStatusData } from './workspace-collection-sync-status-store';

export interface WorkspaceCollectionSyncMetricRow {
  label: string;
  value: string;
}

function formatProgressCount(completed: number, total: number, suffix: string): string {
  return `${completed}/${total} ${suffix}`;
}

function createScanMetricRow(
  scanSummary: WorkspaceCollectionSyncStatusData['scanSummary']
): WorkspaceCollectionSyncMetricRow | null {
  if (!scanSummary) {
    return null;
  }
  return {
    label: 'Scan',
    value: `${scanSummary.discoveredFiles} eligible • ${scanSummary.unchangedFiles} unchanged • ${scanSummary.changedFiles} to update${
      scanSummary.excludedEntries > 0
        ? ` • ${scanSummary.excludedEntries} excluded entr${scanSummary.excludedEntries === 1 ? 'y' : 'ies'}`
        : ''
    }`,
  };
}

function createCoverageMetricRow(
  unindexableFileCount: WorkspaceCollectionSyncStatusData['unindexableFileCount']
): WorkspaceCollectionSyncMetricRow | null {
  if (unindexableFileCount === null || unindexableFileCount <= 0) {
    return null;
  }
  return {
    label: 'Coverage',
    value: `${unindexableFileCount} file${unindexableFileCount === 1 ? '' : 's'} skipped — content cannot be indexed (binary or unreadable)`,
  };
}

function createImportMetricRow(
  importProgress: WorkspaceCollectionSyncStatusData['importProgress']
): WorkspaceCollectionSyncMetricRow | null {
  if (!(importProgress && importProgress.total > 0)) {
    return null;
  }
  return {
    label: 'Import files',
    value: `${formatProgressCount(importProgress.completed, importProgress.total, 'files')}${
      importProgress.errorCount > 0
        ? ` • ${importProgress.errorCount} error${importProgress.errorCount === 1 ? '' : 's'}`
        : ''
    }`,
  };
}

function createChunkingMetricRow(
  chunkingProgress: WorkspaceCollectionSyncStatusData['chunkingProgress']
): WorkspaceCollectionSyncMetricRow | null {
  if (!(chunkingProgress && chunkingProgress.totalFiles > 0)) {
    return null;
  }
  return {
    label: 'Chunking',
    value: `${formatProgressCount(chunkingProgress.filesProcessed, chunkingProgress.totalFiles, 'files')} • ${chunkingProgress.chunksCreated} chunks${
      chunkingProgress.strategyUsed ? ` • ${chunkingProgress.strategyUsed}` : ''
    }`,
  };
}

function createEmbeddingMetricRow(
  embeddingProgress: WorkspaceCollectionSyncStatusData['embeddingProgress']
): WorkspaceCollectionSyncMetricRow | null {
  if (!(embeddingProgress && embeddingProgress.totalChunks > 0)) {
    return null;
  }
  return {
    label: 'Embedded',
    value: `${formatProgressCount(
      embeddingProgress.chunksProcessed,
      embeddingProgress.totalChunks,
      'chunks'
    )}${embeddingProgress.modelName ? ` • ${embeddingProgress.modelName}` : ''}`,
  };
}

function createQueueMetricRow(
  queueProgress: WorkspaceCollectionSyncStatusData['queueProgress']
): WorkspaceCollectionSyncMetricRow | null {
  if (
    !(
      queueProgress &&
      (queueProgress.totalQueued > 0 ||
        queueProgress.processed > 0 ||
        queueProgress.pending > 0 ||
        queueProgress.failed > 0)
    )
  ) {
    return null;
  }
  const queueTotal =
    queueProgress.totalQueued ||
    queueProgress.processed + queueProgress.pending + queueProgress.failed;
  return {
    label: 'Queue',
    value: `${formatProgressCount(queueProgress.processed, queueTotal, 'done')} • ${queueProgress.pending} pending${
      queueProgress.failed > 0 ? ` • ${queueProgress.failed} failed` : ''
    }`,
  };
}

export function getWorkspaceCollectionSyncMetricRows(
  status: Pick<
    WorkspaceCollectionSyncStatusData,
    | 'chunkingProgress'
    | 'embeddingProgress'
    | 'importProgress'
    | 'queueProgress'
    | 'scanSummary'
    | 'unindexableFileCount'
  >
): WorkspaceCollectionSyncMetricRow[] {
  return [
    createScanMetricRow(status.scanSummary),
    createCoverageMetricRow(status.unindexableFileCount),
    createImportMetricRow(status.importProgress),
    createChunkingMetricRow(status.chunkingProgress),
    createEmbeddingMetricRow(status.embeddingProgress),
    createQueueMetricRow(status.queueProgress),
  ].filter((row): row is WorkspaceCollectionSyncMetricRow => row !== null);
}

export function getWorkspaceCollectionSyncCurrentActivity(
  status: Pick<
    WorkspaceCollectionSyncStatusData,
    | 'chunkingProgress'
    | 'currentFilePath'
    | 'embeddingProgress'
    | 'importProgress'
    | 'pauseReasons'
    | 'state'
  >
): { label: string; value: string } | null {
  const pausedActivity = createPausedActivity(status.state, status.pauseReasons);
  if (pausedActivity) {
    return pausedActivity;
  }

  switch (status.state) {
    case 'recovering': {
      const value = status.embeddingProgress?.currentChunk ?? status.currentFilePath;
      return value ? { label: 'Reattaching backfill', value } : null;
    }
    case 'scanning':
      return status.currentFilePath ? { label: 'Scanning', value: status.currentFilePath } : null;
    case 'importing': {
      const value = status.importProgress?.current ?? status.currentFilePath;
      return value ? { label: 'Importing file', value } : null;
    }
    case 'chunking': {
      const value = status.chunkingProgress?.currentFile ?? status.currentFilePath;
      return value ? { label: 'Chunking file', value } : null;
    }
    case 'embedding': {
      const value = status.embeddingProgress?.currentChunk ?? status.currentFilePath;
      return value ? { label: 'Embedding chunk', value } : null;
    }
    default:
      return null;
  }
}

export function shouldShowWorkspaceCollectionSyncPauseControl(
  state: WorkspaceCollectionSyncStatusData['state']
): boolean {
  return (
    state === 'idle' ||
    state === 'paused' ||
    state === 'waiting' ||
    state === 'recovering' ||
    state === 'scanning' ||
    state === 'importing' ||
    state === 'chunking' ||
    state === 'embedding'
  );
}

function createPausedActivity(
  state: WorkspaceCollectionSyncStatusData['state'],
  pauseReasons: readonly string[]
): { label: string; value: string } | null {
  if (state !== 'paused') {
    return null;
  }
  if (pauseReasons.length === 0) {
    return {
      label: 'Paused',
      value: 'Background indexing is paused.',
    };
  }
  return {
    label: 'Paused by',
    value: pauseReasons.join(' • '),
  };
}
