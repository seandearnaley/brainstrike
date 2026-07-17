import type { useToast } from '@brainstrike/ui';
import type { EnhancedImportResult } from '../types';

interface ImportCounts {
  existedButProcessed: number;
  failed: number;
  newFiles: number;
  processingErrors: number;
  totalChunks: number;
  totalEmbeddings: number;
}

function countImportOutcomes(results: EnhancedImportResult[]): ImportCounts {
  const counts: ImportCounts = {
    existedButProcessed: 0,
    failed: 0,
    newFiles: 0,
    processingErrors: 0,
    totalChunks: 0,
    totalEmbeddings: 0,
  };

  // Import batches can be large, so accumulate every summary field in one pass.
  for (const result of results) {
    const { chunksCreated, chunksWithEmbeddings, error, existed, imported } = result;
    if (imported) {
      if (!existed) {
        counts.newFiles += 1;
      }
    } else if (existed) {
      counts.existedButProcessed += 1;
    } else {
      counts.failed += 1;
    }

    if (error && (imported || existed)) {
      counts.processingErrors += 1;
    }
    counts.totalChunks += chunksCreated || 0;
    counts.totalEmbeddings += chunksWithEmbeddings || 0;
  }

  return counts;
}

function buildFileStatusMessage(counts: ImportCounts): string {
  const { newFiles, existedButProcessed, failed } = counts;

  if (newFiles > 0 && existedButProcessed > 0) {
    return `${newFiles} new, ${existedButProcessed} existing`;
  }
  if (newFiles > 0) {
    return `${newFiles} new`;
  }
  if (existedButProcessed > 0) {
    return `${existedButProcessed} existing`;
  }
  if (failed > 0) {
    return `${failed} failed`;
  }
  return 'No files processed';
}

function buildDescription(counts: ImportCounts): string {
  let description = buildFileStatusMessage(counts);

  // Add chunk/embedding info
  if (counts.totalChunks > 0) {
    description += ` • ${counts.totalChunks} chunks created`;
    if (counts.totalEmbeddings > 0) {
      description += `, ${counts.totalEmbeddings} embedded`;
    }
  }

  // Add error counts
  if (counts.failed > 0 && (counts.newFiles > 0 || counts.existedButProcessed > 0)) {
    description += `, ${counts.failed} failed`;
  }
  if (counts.processingErrors > 0) {
    description += `, ${counts.processingErrors} errors`;
  }

  return description;
}

export function createImportCompletionHandler(
  toast: ReturnType<typeof useToast>['toast'],
  loadRecords: () => Promise<void>,
  loadChunks: () => Promise<void>,
  refreshCollectionStats?: () => Promise<void>
) {
  return async (results: EnhancedImportResult[]): Promise<void> => {
    const counts = countImportOutcomes(results);
    const description = buildDescription(counts);

    toast({
      description,
      title: counts.failed > 0 ? 'Import Completed with Errors' : 'Import Complete',
      variant: counts.failed > 0 ? 'destructive' : 'default',
    });

    if (refreshCollectionStats) {
      await refreshCollectionStats();
    }
    await loadRecords();
    await loadChunks();
  };
}
