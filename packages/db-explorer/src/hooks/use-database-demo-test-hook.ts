import { databaseQueryTelemetry } from '@brainstrike/db';
import { useEffect } from 'react';
import { readImportActivitySnapshot } from '../import-activity-snapshot';
import type { EnhancedImportProgress } from '../types';
import type { DatabaseDemoCacheDiagnostics } from '../use-database-demo-data';

type DatabaseDemoImportProgress = EnhancedImportProgress;

interface DatabaseDemoImportTestSnapshot {
  activeCollectionId: string | null;
  isImporting: boolean;
  progress: {
    chunkingProgress: {
      chunksCreated: number;
      currentFile: string;
      filesProcessed: number;
      strategyUsed: string;
      totalFiles: number;
    } | null;
    completed: number;
    current: string;
    errors: Array<{ error: string; file: string }>;
    phase: DatabaseDemoImportProgress['phase'];
    total: number;
  } | null;
  recordCount: number;
  recordPagination: {
    currentPage: number;
    pageSize: number;
    totalRecords: number;
  };
  selectedFileCount: number;
}

interface DatabaseDemoMemoryTestSnapshot {
  activeCollectionId: string | null;
  activeLiveSubscriptions: number;
  cache: DatabaseDemoCacheDiagnostics;
  liveUpdateCount: number;
  recordIds: string[];
}

declare global {
  interface Window {
    __brainstrikeDatabaseDemoTestHooks__?:
      | {
          getImportSnapshot: () => DatabaseDemoImportTestSnapshot;
          getMemorySnapshot: () => DatabaseDemoMemoryTestSnapshot;
        }
      | undefined;
    desktopLifecycle?:
      | {
          isTestMode?: boolean;
        }
      | undefined;
  }
}

interface UseDatabaseDemoTestHookOptions {
  readonly activeCollectionId: string | null;
  readonly getCacheDiagnostics: () => DatabaseDemoCacheDiagnostics;
  /** App-wide import activity, not this panel's own (it runs no imports). */
  readonly isImporting: boolean;
  readonly recordCount: number;
  readonly recordCurrentPage: number;
  readonly recordIds: readonly string[];
  readonly recordPageSize: number;
  readonly recordTotalRecords: number;
}

const MAX_TEST_RECORD_IDS = 100;

function projectProgress(
  progress: DatabaseDemoImportProgress | null
): DatabaseDemoImportTestSnapshot['progress'] {
  if (!progress) {
    return null;
  }
  return {
    chunkingProgress: progress.chunkingProgress
      ? {
          chunksCreated: progress.chunkingProgress.chunksCreated,
          currentFile: progress.chunkingProgress.currentFile ?? '',
          filesProcessed: progress.chunkingProgress.filesProcessed,
          strategyUsed: progress.chunkingProgress.strategyUsed ?? '',
          totalFiles: progress.chunkingProgress.totalFiles,
        }
      : null,
    completed: progress.completed,
    current: progress.current ?? '',
    errors: progress.errors.map((entry) => ({ error: entry.error, file: entry.file })),
    phase: progress.phase,
    total: progress.total,
  };
}

export function useDatabaseDemoTestHook({
  activeCollectionId,
  getCacheDiagnostics,
  isImporting,
  recordCount,
  recordCurrentPage,
  recordPageSize,
  recordIds,
  recordTotalRecords,
}: UseDatabaseDemoTestHookOptions): void {
  useEffect(() => {
    if (!window.desktopLifecycle?.isTestMode) {
      return;
    }

    window.__brainstrikeDatabaseDemoTestHooks__ = {
      getImportSnapshot: () => {
        // Read at call time: the import runs on another surface, so its
        // progress must not be frozen into this effect's closure.
        const importActivity = readImportActivitySnapshot();
        return {
          activeCollectionId,
          isImporting,
          progress: projectProgress(importActivity.progress),
          recordCount,
          recordPagination: {
            currentPage: recordCurrentPage,
            pageSize: recordPageSize,
            totalRecords: recordTotalRecords,
          },
          selectedFileCount: importActivity.selectedFileCount,
        };
      },
      getMemorySnapshot: () => {
        const telemetry = databaseQueryTelemetry.snapshot();
        return {
          activeCollectionId,
          activeLiveSubscriptions: telemetry.activeLiveSubscriptions,
          cache: getCacheDiagnostics(),
          liveUpdateCount: telemetry.liveUpdateCount,
          recordIds: recordIds.slice(0, MAX_TEST_RECORD_IDS),
        };
      },
    };

    return () => {
      window.__brainstrikeDatabaseDemoTestHooks__ = undefined;
    };
  }, [
    activeCollectionId,
    getCacheDiagnostics,
    isImporting,
    recordCount,
    recordCurrentPage,
    recordPageSize,
    recordIds,
    recordTotalRecords,
  ]);
}
