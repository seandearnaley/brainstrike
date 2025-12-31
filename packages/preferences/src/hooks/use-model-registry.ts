import type { IDatabase } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db';
import { useEffect } from 'react';
import { useModelRegistryStore } from '../stores/model-registry-store';

export type UseEnsureModelRegistryOptions = {
  db?: IDatabase | null;
  enabled?: boolean;
};

export function useEnsureModelRegistry(options: UseEnsureModelRegistryOptions = {}): void {
  const contextDb = usePGliteDatabase();
  const db = options.db ?? contextDb;
  const enabled = options.enabled ?? true;
  const ensureRegistry = useModelRegistryStore((state) => state.ensureRegistry);

  useEffect(() => {
    if (!(enabled && db)) {
      return;
    }
    void ensureRegistry(db);
  }, [db, enabled, ensureRegistry]);
}
