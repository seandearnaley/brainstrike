import type {
  PromptItem,
  PromptItemRepositoryPort,
  PromptItemWire,
  PromptLibraryCapability,
  PromptLibraryReply,
} from '@brainstrike/types/prompt-item';

function itemFromWire(item: PromptItemWire): PromptItem {
  return {
    ...item,
    archivedAt: item.archivedAt ? new Date(item.archivedAt) : null,
    createdAt: new Date(item.createdAt),
    embeddingUpdatedAt: item.embeddingUpdatedAt ? new Date(item.embeddingUpdatedAt) : null,
    lastUsedAt: item.lastUsedAt ? new Date(item.lastUsedAt) : null,
    updatedAt: new Date(item.updatedAt),
  };
}
function requireItem(reply: PromptLibraryReply): PromptItem {
  const item = reply.items[0];
  if (!item) {
    throw new Error('Prompt Library operation returned no item');
  }
  return itemFromWire(item);
}
/** Renderer projection of the existing host-owned catalog, with no SQL fallback. */
export function createPromptLibraryRepository(
  capability: PromptLibraryCapability
): PromptItemRepositoryPort {
  return {
    create: async (input) => requireItem(await capability.request({ input, operation: 'create' })),
    delete: async (id) => {
      await capability.request({ id, operation: 'delete' });
    },
    findById: async (id) => {
      const item = (await capability.request({ id, operation: 'get' })).items[0];
      return item ? itemFromWire(item) : null;
    },
    getEmbeddingProfile: async () => (await capability.request({ operation: 'profile' })).profile,
    list: async (filter = {}) =>
      (await capability.request({ filter, operation: 'list' })).items.map(itemFromWire),
    listNeedingEmbedding: async () =>
      (await capability.request({ operation: 'pending' })).items.map(itemFromWire),
    listRevisions: async (id) =>
      (await capability.request({ id, operation: 'revisions' })).revisions.map((revision) => ({
        ...revision,
        createdAt: new Date(revision.createdAt),
      })),
    markEmbeddingError: async (id, revision, error) =>
      (await capability.request({ error, id, operation: 'embedding-error', revision })).accepted,
    recordUsage: async (id, action) =>
      requireItem(await capability.request({ action, id, operation: 'usage' })),
    searchSimilar: async (vector, options = {}) => {
      const reply = await capability.request({ operation: 'similar', options, vector });
      return reply.similarities.map((hit) => {
        const item = reply.items.find((row) => row.id === hit.id && row.revision === hit.revision);
        if (!item) {
          throw new Error('Prompt Library search returned an unknown revision');
        }
        return { ...itemFromWire(item), similarity: hit.similarity };
      });
    },
    storeEmbedding: async (input) =>
      (await capability.request({ input, operation: 'store-embedding' })).accepted,
    update: async (input) => requireItem(await capability.request({ input, operation: 'update' })),
  };
}
