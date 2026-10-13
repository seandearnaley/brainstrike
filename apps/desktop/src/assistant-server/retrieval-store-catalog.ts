import type {
  CollectionPort,
  SourceCatalogPort,
  WorkspaceRootPort,
} from '@brainstrike/state-store';
import type { RetrievalStore } from './retrieval-store';
/** Borrows the profile's one SQLite catalog; native coverage remains owned by IndexSearch. */
export function createCatalogRetrievalStore(
  store: CollectionPort & SourceCatalogPort & WorkspaceRootPort
): RetrievalStore {
  return {
    embeddingSet: async (id) => {
      const row = (await store.collections({ id, operation: 'get' })).collections[0];
      if (!row || row.id !== id) {
        throw new Error('The selected collection no longer exists. Choose another collection.');
      }
      return {
        dimensions: row.dimensions,
        distance: row.distance,
        modelId: row.modelId,
        modelKey: row.modelKey,
      };
    },
    embeddingSpaces: async ({ includeStats }) =>
      (await store.collections({ operation: 'list' })).collections.map((row) => ({
        createdAt: row.createdAt,
        description: row.description ?? null,
        dimensions: row.dimensions,
        distance: row.distance,
        id: row.id,
        modelId: row.modelId,
        modelKey: row.modelKey,
        name: row.name ?? null,
        ...(includeStats
          ? {
              statsUnavailableReason:
                'Chunk, token and vector statistics are available only through the active native index coverage.',
            }
          : {}),
      })),
    fileRecords: async (ids) => {
      if (ids.length === 0) {
        return new Map();
      }
      const roots = new Map(
        (await store.workspaceRoots({ operation: 'list' })).roots.map((root) => [root.id, root])
      );
      const unique = [...new Set(ids)];
      const files = [];
      for (let offset = 0; offset < unique.length; offset += 250) {
        files.push(
          ...(
            await store.sourceCatalog({
              fileIds: unique.slice(offset, offset + 250),
              maxContentBytes: 0,
              operation: 'read',
            })
          ).files
        );
      }
      return new Map(
        files.map((file) => [
          file.fileId,
          {
            id: file.fileId,
            name: file.fileName,
            path: file.path,
            rootId: file.rootId,
            rootName: file.rootId === null ? null : (roots.get(file.rootId)?.displayName ?? null),
            tokenCount: null,
          },
        ])
      );
    },
  };
}
