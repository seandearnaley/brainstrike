import { type DrizzleFileRecordRepository, useFileRecordRepository } from '@brainstrike/db';
import { useEffect } from 'react';
import { useDatabaseStatusStore } from '../stores/database-status-store';

function resolveLocation(_repo: DrizzleFileRecordRepository): {
  location: string;
  testResult: string;
} {
  // Detect Electron IPC environment via window.electronAPI
  if (typeof window !== 'undefined' && (window as { electronAPI?: unknown }).electronAPI) {
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
  const repository = useFileRecordRepository();

  useEffect(() => {
    const store = useDatabaseStatusStore.getState();

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
  }, [repository]);
}
