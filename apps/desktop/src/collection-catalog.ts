import { randomUUID } from 'node:crypto';
import {
  type CollectionCatalogCapability,
  findProviderDefinition,
  WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS,
} from '@brainstrike/assistant-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { CollectionPort, CollectionRecord } from '@brainstrike/state-store';
import { readCollectionSnapshot } from './collection-counts';

export interface DesktopCollectionCatalogDependencies {
  /** Join the existing native source/index owner before removing selected collection authority. */
  readonly deleteCollection: (id: string, commit: () => Promise<boolean>) => Promise<boolean>;
  readonly native: () => Pick<IndexSearchCapability, 'status' | 'coverageBatch'>;
  readonly store: CollectionPort;
}

function validateProfile(
  input: Pick<CollectionRecord, 'modelKey' | 'modelId' | 'dimensions' | 'distance'>
): void {
  const separator = input.modelKey.indexOf('::');
  const provider = findProviderDefinition(input.modelKey.slice(0, separator));
  if (
    !provider ||
    separator <= 0 ||
    input.modelKey.slice(separator + 2) !== input.modelId ||
    !input.modelId.trim()
  ) {
    throw new Error('Collection requires an explicit supported provider/model identity.');
  }
  const model = provider.models.find((candidate) => candidate.id === input.modelId);
  // Runtime-discovered providers declare their actual model identity at creation; inference verifies dimensions.
  if (
    !(provider.runtime === 'local' && provider.authType === 'none') &&
    model?.type !== 'embedding'
  ) {
    throw new Error('Collection requires a registered embedding model.');
  }
  if (
    !Number.isSafeInteger(input.dimensions) ||
    input.dimensions <= 0 ||
    input.dimensions > 16_000 ||
    !(['cosine', 'l2', 'ip'] as readonly string[]).includes(input.distance)
  ) {
    throw new Error('Collection vector profile is invalid.');
  }
}

export function createDesktopCollectionCatalog({
  store,
  deleteCollection,
  native,
}: DesktopCollectionCatalogDependencies): CollectionCatalogCapability {
  const create = async (
    input: Omit<CollectionRecord, 'id' | 'createdAt'>
  ): Promise<CollectionRecord> => {
    validateProfile(input);
    const result = await store.collections({
      collection: {
        ...input,
        createdAt: new Date().toISOString(),
        id: randomUUID(),
      },
      operation: 'create',
    });
    const collection = result.collections[0];
    if (!collection || result.collections.length !== 1) {
      throw new Error('Collection writer omitted the created identity.');
    }
    return collection;
  };
  return {
    create: ({ metadata, ...profile }) => create({ ...profile, ...metadata }),
    delete: async (id) => {
      const existing = (await store.collections({ id, operation: 'get' })).collections;
      if (existing.length === 0) {
        return false;
      }
      if (existing.length !== 1 || existing[0]?.id !== id) {
        throw new Error('Collection owner returned an invalid deletion identity.');
      }
      return deleteCollection(
        id,
        async () => (await store.collections({ id, operation: 'delete' })).collections.length > 0
      );
    },
    ensureWorkspaceIndex: () => create(WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS),
    get: async (id) => (await store.collections({ id, operation: 'get' })).collections[0] ?? null,
    list: async () => (await store.collections({ operation: 'list' })).collections,
    snapshot: () => readCollectionSnapshot(store, native()),
    update: async (id, metadata) =>
      (await store.collections({ id, metadata, operation: 'update' })).collections[0] ?? null,
  };
}
