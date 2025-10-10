import type { useToast } from '@brainstrike/ui';
import type { EnhancedImportResult } from '../types';

export function createImportCompletionHandler(
  toast: ReturnType<typeof useToast>['toast'],
  loadRecords: () => Promise<void>,
  loadChunks: () => Promise<void>
) {
  return (results: EnhancedImportResult[]) => {
    const imported = results.filter((r) => r.imported).length;
    const importFailed = results.filter((r) => !r.imported).length;
    const processingErrors = results.filter((r) => r.imported && r.error).length;
    const totalChunks = results.reduce((acc, r) => acc + (r.chunksCreated || 0), 0);
    const totalEmbeddings = results.reduce((acc, r) => acc + (r.chunksWithEmbeddings || 0), 0);

    let description = `${imported} files imported`;
    if (importFailed > 0) {
      description += `, ${importFailed} import failed`;
    }
    if (processingErrors > 0) {
      description += `, ${processingErrors} processing errors`;
    }
    if (totalChunks > 0) {
      description += `, ${totalChunks} chunks created`;
    }
    if (totalEmbeddings > 0) {
      description += `, ${totalEmbeddings} embeddings generated`;
    }

    toast({
      title: 'Import Complete',
      description,
      variant: importFailed > 0 ? 'destructive' : processingErrors > 0 ? 'default' : 'default',
    });

    // Refresh the records to show new imports
    void loadRecords();
    void loadChunks();
  };
}
