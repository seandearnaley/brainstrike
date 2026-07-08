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
  return {
    existedButProcessed: results.filter((r) => !r.imported && r.existed).length,
    failed: results.filter((r) => !(r.imported || r.existed)).length,
    newFiles: results.filter((r) => r.imported && !r.existed).length,
    processingErrors: results.filter((r) => r.error && (r.imported || r.existed)).length,
    totalChunks: results.reduce((acc, r) => acc + (r.chunksCreated || 0), 0),
    totalEmbeddings: results.reduce((acc, r) => acc + (r.chunksWithEmbeddings || 0), 0),
  };
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
