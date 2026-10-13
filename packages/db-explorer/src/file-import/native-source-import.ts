import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import type { FileImportRepositoryPort } from './file-import-types';

export function getSourceFilesCapability(): SourceFilesCapability | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as Window & { sourceFiles?: SourceFilesCapability }).sourceFiles;
}

/** Native Main owns durable import and its existing collection ingestion join. */
export function createNativeImportRepository(
  sourceFiles: SourceFilesCapability
): FileImportRepositoryPort {
  return {
    async bulkImport(requests, onProgress) {
      const embeddingSetId = requests[0]?.embeddingSetId ?? null;
      if (requests.some((request) => (request.embeddingSetId ?? null) !== embeddingSetId)) {
        throw new Error('A source import batch must target one collection.');
      }
      const receipt = await sourceFiles.import({
        embeddingSetId,
        files: requests.map(({ name, path, content, size }) => ({ content, name, path, size })),
      });
      onProgress(receipt.items.length, requests.length);
      return receipt.items.map(({ file, imported }) => ({
        chunksCreated: file.chunksCount ?? 0,
        existed: !imported,
        id: file.fileId,
        imported,
        ...(receipt.indexing.kind === 'pending' ? { error: receipt.indexing.reason } : {}),
      }));
    },
  };
}
