import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import {
  type BoundaryTransport,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import { useEffect } from 'react';
import { useDatabaseStatusStore } from '../stores/database-status-store.ts';

/**
 * Keeps the global database status store in sync with the native model catalog connection state.
 * Runs even when the Database tab is not mounted so the status bar reflects reality.
 */
export function useDatabaseStatusSync(): void {
  const transport =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { modelCatalog?: BoundaryTransport<ModelCatalogCapability> })
          .modelCatalog;
  const catalog = transport
    ? createBoundaryCapability<ModelCatalogCapability>(transport)
    : undefined;

  useEffect(() => {
    const store = useDatabaseStatusStore.getState();
    if (!catalog) {
      if (!store.loading) {
        store.setLoading();
      }
      return;
    }

    let active = true;
    store.setLoading();
    // A read during a reset waits in Main for the reopened host, so it never latches a refusal.
    void catalog.read().then(
      () => {
        if (active) {
          store.setConnected('SQLite', 'Connected (agent host)');
        }
      },
      (error: unknown) => {
        if (active) {
          store.setDisconnected('SQLite', error instanceof Error ? error.message : String(error));
        }
      }
    );
    return () => {
      active = false;
    };
  }, [catalog]);
}
