import { createHash } from 'node:crypto';
import type { SourceFilesCapability, SourceImportIndexing } from '@brainstrike/assistant-contract';
import type { SourceCatalogPort, SourceCatalogRecord } from '@brainstrike/state-store';

interface Dependencies {
  readonly catalog: SourceCatalogPort;
  readonly publishSources: (embeddingSetId: string | null) => Promise<SourceImportIndexing>;
  readonly readChunks: SourceFilesCapability['chunks'];
  /** Existing native mutation admission joins physical index retirement before canonical removal. */
  readonly removeSources: (files: readonly SourceCatalogRecord[]) => Promise<void>;
}

export function createDesktopSourceFiles({
  catalog,
  removeSources,
  publishSources,
  readChunks,
}: Dependencies): SourceFilesCapability {
  return {
    chunks: readChunks,
    delete: async (fileIds) => {
      const captured = (await catalog.sourceCatalog({ fileIds, operation: 'read' })).files;
      await removeSources(captured);
    },
    import: async ({ embeddingSetId, files }) => {
      const reply = await catalog.sourceCatalog({
        embeddingSetId,
        files: files.map((file) => ({
          content: file.content,
          contentHash: createHash('sha256').update(file.content).digest('hex'),
          fileName: file.name,
          path: file.path,
          stat: { mtimeMs: null, size: file.size },
        })),
        operation: 'import',
      });
      if (
        !reply.imported ||
        reply.imported.length !== files.length ||
        reply.files.length !== files.length
      ) {
        throw new Error('Source import omitted its authoritative commit receipts');
      }
      const indexing = await publishSources(embeddingSetId);
      const current =
        indexing.kind === 'complete'
          ? (
              await catalog.sourceCatalog({
                fileIds: reply.files.map((file) => file.fileId),
                operation: 'read',
              })
            ).files
          : reply.files;
      if (
        current.length !== reply.files.length ||
        current.some((file, index) => file.fileId !== reply.files[index]?.fileId)
      ) {
        throw new Error('Source publication returned different canonical identities');
      }
      const items = current.map((file, index) => ({
        file,
        imported: reply.imported?.[index] === true,
      }));
      return { indexing, items };
    },
    list: async () => (await catalog.sourceCatalog({ operation: 'list' })).files,
    read: async (fileIds, maxContentBytes) =>
      (await catalog.sourceCatalog({ fileIds, maxContentBytes, operation: 'read' })).files,
  };
}
