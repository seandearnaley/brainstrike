import type { DbHandle } from '@brainstrike/db';
import type { FileSystemAdapter } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useRef } from 'react';
import { reconcileRoots } from './root-registry';

const logger = createLogger('useRootsReconciliation');

export interface UseRootsReconciliationArgs {
  adapter: FileSystemAdapter;
  db: DbHandle | null;
}

/**
 * Runs once per app boot (ref guard) to ensure a DB roots row exists for every
 * adapter root that has a persistent backing store entry. No-ops unless
 * adapter.restoreRoots exists and the db handle is ready. Errors are logged at
 * error level and swallowed — reconciliation must never block boot.
 *
 * Returns void: the mapping is intentionally not exposed as React state here.
 * Phase 3 wires consumers via the registry mapping when import pipelines need it.
 */
export function useRootsReconciliation({ adapter, db }: UseRootsReconciliationArgs): void {
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) {
      return;
    }
    if (!(adapter.restoreRoots && db)) {
      return;
    }
    hasRunRef.current = true;

    const platformKind = adapter.platform === 'electron' ? 'path' : 'fsa';

    void adapter
      .restoreRoots()
      .then((adapterRoots) =>
        reconcileRoots({
          adapterRoots,
          platformKind,
          query: db.query,
        })
      )
      .catch((err: unknown) => {
        logger.error('Root reconciliation failed', { error: err });
      });
  }, [adapter, db]);
}
