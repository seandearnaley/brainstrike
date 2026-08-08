import { useEffect } from 'react';
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
  readonly isImporting: boolean;
  readonly progress: DatabaseDemoImportProgress | null;
  readonly recordCount: number;
  readonly recordCurrentPage: number;
  readonly recordPageSize: number;
  readonly recordTotalRecords: number;
  readonly selectedFileCount: number;
}

export function useDatabaseDemoTestHook({
  activeCollectionId,
  isImporting,
  progress,
  recordCount,
  recordCurrentPage,
  recordPageSize,
  recordTotalRecords,
  selectedFileCount,
}: UseDatabaseDemoTestHookOptions): void {
  useEffect(() => {
    if (!window.desktopLifecycle?.isTestMode) {
      return;
    }

    window.__brainstrikeDatabaseDemoTestHooks__ = {
      getImportSnapshot: () => ({
        activeCollectionId,
        isImporting,
        progress: progress
          ? {
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
            }
          : null,
        recordCount,
        recordPagination: {
          currentPage: recordCurrentPage,
          pageSize: recordPageSize,
          totalRecords: recordTotalRecords,
        },
        selectedFileCount,
      }),
    };

    return () => {
      window.__brainstrikeDatabaseDemoTestHooks__ = undefined;
    };
  }, [
    activeCollectionId,
    isImporting,
    progress,
    recordCount,
    recordCurrentPage,
    recordPageSize,
    recordTotalRecords,
    selectedFileCount,
  ]);
}
