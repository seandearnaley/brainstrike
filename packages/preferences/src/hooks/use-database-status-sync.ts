import {
  type DbInitializationStatus,
  type DrizzleFileRecordRepository,
  ElectronFileRecordRepository,
  type ProfileBootstrapReport,
  useFileRecordRepository,
  useOptionalDbInitializationStatus,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
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

function resolvePartialRuntimeStatus(
  initializationStatus: DbInitializationStatus,
  report: ProfileBootstrapReport
): { location: string; testResult: string } | null {
  if (initializationStatus !== 'ready' || !report.ready || report.runtime.engine !== 'turso') {
    return null;
  }

  return {
    location: 'Turso',
    testResult: 'Connected (partial: view_filter_presets)',
  };
}

/**
 * Keeps the global database status store in sync with the DbProvider connection state.
 * Runs even when the Database tab is not mounted so the status bar reflects reality.
 */
export function useDatabaseStatusSync(): void {
  const initializationStatus = useOptionalDbInitializationStatus();
  const repository = useFileRecordRepository();
  const profileBootstrapReport = useOptionalProfileBootstrapReport();

  useEffect(() => {
    const store = useDatabaseStatusStore.getState();
    const repositoryStatus = repository ? resolveLocation(repository) : null;
    const partialRuntimeStatus = profileBootstrapReport
      ? resolvePartialRuntimeStatus(initializationStatus, profileBootstrapReport)
      : null;
    const status = repositoryStatus ?? partialRuntimeStatus;

    if (!status) {
      if (!store.loading) {
        store.setLoading();
      }
      return;
    }

    const { location, testResult } = status;
    if (
      store.connected &&
      !store.loading &&
      store.location === location &&
      store.testResult === testResult
    ) {
      return;
    }

    store.setConnected(location, testResult);
  }, [initializationStatus, profileBootstrapReport, repository]);
}
