import type { CollectionCatalogCapability } from '@brainstrike/assistant-contract';
import {
  type BoundaryTransport,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import { useMemo } from 'react';
import { createCollectionCatalogRepository } from './repositories/collection-catalog-repository.js';
import type { IEmbeddingSetsRepository } from './repositories/interfaces.js';

/** The collection catalog the desktop preload exposes as `window.collectionCatalog`. */
export function useEmbeddingSetsRepository(): IEmbeddingSetsRepository | null {
  const transport =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { collectionCatalog?: BoundaryTransport<CollectionCatalogCapability> })
          .collectionCatalog;
  const catalog = transport
    ? createBoundaryCapability<CollectionCatalogCapability>(transport)
    : undefined;
  return useMemo(() => (catalog ? createCollectionCatalogRepository(catalog) : null), [catalog]);
}
