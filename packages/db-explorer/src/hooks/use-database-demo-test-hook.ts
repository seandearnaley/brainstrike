import { useEffect } from 'react';
import { readImportActivitySnapshot } from '../import-activity-snapshot';
import type { EnhancedImportProgress } from '../types';

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

declare global {
  interface Window {
    __brainstrikeDatabaseDemoTestHooks__?:
      | {
          getImportSnapshot: () => DatabaseDemoImportTestSnapshot;
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
  /** App-wide import activity, not this panel's own (it runs no imports). */
  readonly isImporting: boolean;
  readonly recordCount: number;
  readonly recordCurrentPage: number;
  readonly recordPageSize: number;
  readonly recordTotalRecords: number;
}

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
  isImporting,
  recordCount,
  recordCurrentPage,
  recordPageSize,
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
    };

    return () => {
      window.__brainstrikeDatabaseDemoTestHooks__ = undefined;
    };
  }, [
    activeCollectionId,
    isImporting,
    recordCount,
    recordCurrentPage,
    recordPageSize,
    recordTotalRecords,
  ]);
}
