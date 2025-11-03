import type { useToast } from '@brainstrike/ui';
import type { EnhancedImportResult } from '../types';

export function createImportCompletionHandler(
  toast: ReturnType<typeof useToast>['toast'],
  loadRecords: () => Promise<void>,
  loadChunks: () => Promise<void>
) {
  return (results: EnhancedImportResult[]) => {
    const newFiles = results.filter((r) => r.imported && !r.existed).length;
    const existingFiles = results.filter((r) => r.imported && r.existed).length;
    const importFailed = results.filter((r) => !r.imported).length;
    const processingErrors = results.filter((r) => r.imported && r.error).length;
    const totalChunks = results.reduce((acc, r) => acc + (r.chunksCreated || 0), 0);
    const totalEmbeddings = results.reduce((acc, r) => acc + (r.chunksWithEmbeddings || 0), 0);

    // Build user-friendly description
    let description = '';

    // File status
    if (newFiles > 0 && existingFiles > 0) {
      description = `${newFiles} new files, ${existingFiles} existing files added to collection`;
    } else if (newFiles > 0) {
      description = `${newFiles} new files imported`;
    } else if (existingFiles > 0) {
      description = `${existingFiles} existing files added to collection`;
    } else {
      description = 'No files imported';
    }

    // Errors
    if (importFailed > 0) {
      description += `, ${importFailed} failed`;
    }
    if (processingErrors > 0) {
      description += `, ${processingErrors} processing errors`;
    }

    // Chunks and embeddings
    if (totalChunks > 0) {
      description += ` • ${totalChunks} chunks created`;
    }
    if (totalEmbeddings > 0) {
      description += `, ${totalEmbeddings} embedded`;
    }

    toast({
      title: importFailed > 0 ? 'Import Completed with Errors' : 'Import Complete',
      description,
      variant: importFailed > 0 ? 'destructive' : 'default',
    });

    // Refresh the records to show new imports
    void loadRecords();
    void loadChunks();
  };
}
