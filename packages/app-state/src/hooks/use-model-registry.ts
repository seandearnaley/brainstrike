import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import {
  type BoundaryTransport,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useEffect } from 'react';
import { type ModelRegistrySource, useModelRegistryStore } from '../stores/model-registry-store';

const logger = createLogger('UseEnsureModelRegistry');

export interface UseEnsureModelRegistryOptions {
  db?: ModelRegistrySource | null;
  enabled?: boolean;
}

/** Capability presence selects its writer; errors never switch to the web database. */
export function useModelRegistrySource(
  providedSource?: ModelRegistrySource | null
): ModelRegistrySource | null {
  const transport =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { modelCatalog?: BoundaryTransport<ModelCatalogCapability> })
          .modelCatalog;
  const catalog = transport
    ? createBoundaryCapability<ModelCatalogCapability>(transport)
    : undefined;
  const contextDb = usePGliteDatabase({ enabled: !(catalog || providedSource) });
  return catalog ?? providedSource ?? contextDb;
}

export function useEnsureModelRegistry(options: UseEnsureModelRegistryOptions = {}): string | null {
  const db = useModelRegistrySource(options.db);
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
