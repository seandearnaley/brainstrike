import type { IDatabase } from '@brainstrike/db';
import { useModelRegistryDbClient } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect } from 'react';
import { useModelRegistryStore } from '../stores/model-registry-store';

const logger = createLogger('UseEnsureModelRegistry');

export interface UseEnsureModelRegistryOptions {
  db?: IDatabase | null;
  enabled?: boolean;
}

export function useEnsureModelRegistry(options: UseEnsureModelRegistryOptions = {}): string | null {
  const contextDb = useModelRegistryDbClient();
  const db = options.db ?? contextDb;
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
