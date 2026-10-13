import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { type DrizzleFileRecordRepository, ElectronFileRecordRepository } from '@brainstrike/db';
import { useFileRecordRepository } from '@brainstrike/db/react';
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
  const catalog =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { modelCatalog?: ModelCatalogCapability }).modelCatalog;
  const repository = useFileRecordRepository({ enabled: !catalog });

  useEffect(() => {
    const store = useDatabaseStatusStore.getState();
    if (catalog) {
      let active = true;
      store.setLoading();
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
  }, [catalog, repository]);
}
