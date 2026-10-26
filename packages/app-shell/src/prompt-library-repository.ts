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
    list: async (filter = {}) =>
      (await capability.request({ filter, operation: 'list' })).items.map(itemFromWire),
    listRevisions: async (id) =>
      (await capability.request({ id, operation: 'revisions' })).revisions.map((revision) => ({
        ...revision,
        createdAt: new Date(revision.createdAt),
      })),
    recordUsage: async (id, action) =>
      requireItem(await capability.request({ action, id, operation: 'usage' })),
    update: async (input) => requireItem(await capability.request({ input, operation: 'update' })),
  };
}
