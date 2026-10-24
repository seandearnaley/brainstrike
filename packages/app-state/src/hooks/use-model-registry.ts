import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import {
  type BoundaryTransport,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import { useEffect } from 'react';
import { type ModelRegistrySource, useModelRegistryStore } from '../stores/model-registry-store.ts';

const logger = createLogger('UseEnsureModelRegistry');

export interface UseEnsureModelRegistryOptions {
  enabled?: boolean;
}

/** The model catalog capability, or null when the host does not expose one. */
export function useModelRegistrySource(): ModelRegistrySource | null {
  const transport =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { modelCatalog?: BoundaryTransport<ModelCatalogCapability> })
          .modelCatalog;
  const catalog = transport
    ? createBoundaryCapability<ModelCatalogCapability>(transport)
    : undefined;
  return catalog ?? null;
}

export function useEnsureModelRegistry(options: UseEnsureModelRegistryOptions = {}): string | null {
  const db = useModelRegistrySource();
  const enabled = options.enabled ?? true;
  const ensureRegistry = useModelRegistryStore((state) => state.ensureRegistry);
  const error = useModelRegistryStore((state) => state.error);

  useEffect(() => {
    if (!(enabled && db)) {
      return;
    }
    void ensureRegistry(db).catch((error) => {
      logger.error('Failed to load model registry', error);
    });
  }, [db, enabled, ensureRegistry]);

  return error;
}
