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
    'chunkingProgress' | 'embeddingProgress' | 'importProgress' | 'queueProgress' | 'scanSummary'
  >
): WorkspaceCollectionSyncMetricRow[] {
  return [
    createScanMetricRow(status.scanSummary),
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

  const stateActivity = {
    recovering: {
      label: 'Reattaching backfill',
      value: status.embeddingProgress?.currentChunk ?? status.currentFilePath,
    },
    scanning: {
      label: 'Scanning',
      value: status.currentFilePath,
    },
    importing: {
      label: 'Importing file',
      value: status.importProgress?.current ?? status.currentFilePath,
    },
    chunking: {
      label: 'Chunking file',
      value: status.chunkingProgress?.currentFile ?? status.currentFilePath,
    },
    embedding: {
      label: 'Embedding chunk',
      value: status.embeddingProgress?.currentChunk ?? status.currentFilePath,
    },
  } as const;

  const activity =
    status.state in stateActivity
      ? stateActivity[status.state as keyof typeof stateActivity]
      : null;
  if (!activity?.value) {
    return null;
  }
  return {
    label: activity.label,
    value: activity.value,
  };
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
