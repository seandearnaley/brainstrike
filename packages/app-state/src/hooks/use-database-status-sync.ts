import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import {
  type BoundaryTransport,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import { type DrizzleFileRecordRepository, ElectronFileRecordRepository } from '@brainstrike/db';
import { useFileRecordRepository } from '@brainstrike/db/react';
import type { IndexLifecycleCapability } from '@brainstrike/indexing-contract/indexer-client';
import { useEffect } from 'react';
import { useDatabaseStatusStore } from '../stores/database-status-store';

function resolveLocation(repo: DrizzleFileRecordRepository | ElectronFileRecordRepository): {
  location: string;
  testResult: string;
} {
  if (repo instanceof ElectronFileRecordRepository) {
    return {
      location: 'Main Process',
      testResult: 'Connected (IPC)',
    };
  }

  return {
    location: 'PGlite WASM',
    testResult: 'connected',
  };
}

/**
 * Keeps the global database status store in sync with the DbProvider connection state.
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
  const lifecycle =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { indexSearch?: IndexLifecycleCapability }).indexSearch;
  const repository = useFileRecordRepository({ enabled: !catalog });

  useEffect(() => {
    const store = useDatabaseStatusStore.getState();
    if (catalog) {
      let active = true;
      let latest = 0;
      const read = (): void => {
        const request = ++latest;
        void catalog.read().then(
          () => {
            if (active && request === latest) {
              store.setConnected('SQLite', 'Connected (agent host)');
            }
          },
          (error: unknown) => {
            if (active && request === latest) {
              store.setDisconnected(
                'SQLite',
                error instanceof Error ? error.message : String(error)
              );
            }
          }
        );
      };
      store.setLoading();
      read();
      // Clear replaces this renderer before the host reopens; the lifecycle push
      // announces the reopened host, so a refused first read does not latch.
      const unsubscribe = lifecycle?.onLifecycleChanged(read);
      return () => {
        active = false;
        unsubscribe?.();
      };
    }

    if (!repository) {
      if (!store.loading) {
        store.setLoading();
      }
      return;
    }

    const { location, testResult } = resolveLocation(repository);
    if (
      store.connected &&
      !store.loading &&
      store.location === location &&
      store.testResult === testResult
    ) {
      return;
    }

    store.setConnected(location, testResult);
    return;
  }, [catalog, lifecycle, repository]);
}
