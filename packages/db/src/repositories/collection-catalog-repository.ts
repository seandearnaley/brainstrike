import type { CollectionCatalogCapability } from '@brainstrike/assistant-contract';
import type { IEmbeddingSetsRepository } from './interfaces.js';

/** Shared UI repository shape backed by the desktop's existing authoritative writer. */
export function createCollectionCatalogRepository(
  catalog: CollectionCatalogCapability
): IEmbeddingSetsRepository {
  return {
    delete: (id) => catalog.delete(id),
    findAll: async () => [...(await catalog.list())],
    getById: (id) => catalog.get(id),
    getByModelKey: async (modelKey) =>
      (await catalog.list()).filter((item) => item.modelKey === modelKey),
    getOrCreateSet: (modelKey, modelId, dimensions, distance, metadata) =>
      catalog.create({
        dimensions,
        distance,
        modelId,
        modelKey,
        ...(metadata ? { metadata } : {}),
      }),
    getOrCreateWorkspaceIndexSet: () => catalog.ensureWorkspaceIndex(),
    updateMetadata: (id, metadata) => catalog.update(id, metadata),
  };
}
