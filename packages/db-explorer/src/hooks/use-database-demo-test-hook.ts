import type { ImportProgress } from '@brainstrike/db';
import { useEffect } from 'react';
import type { EnhancedImportProgress } from '../types';

type DatabaseDemoImportProgress = EnhancedImportProgress & ImportProgress;

interface DatabaseDemoImportTestSnapshot {
  activeCollectionId: string | null;
  isImporting: boolean;
  progress: {
    completed: number;
    current: string;
    errors: Array<{ error: string; file: string }>;
    phase: DatabaseDemoImportProgress['phase'];
    total: number;
  } | null;
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
  readonly recordPagination: {
    readonly currentPage: number;
    readonly pageSize: number;
    readonly totalRecords: number;
  };
  readonly selectedFileCount: number;
}

export function useDatabaseDemoTestHook({
  activeCollectionId,
  isImporting,
  progress,
  recordCount,
  recordPagination,
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
        recordPagination,
        selectedFileCount,
      }),
    };

    return () => {
      window.__brainstrikeDatabaseDemoTestHooks__ = undefined;
    };
  }, [activeCollectionId, isImporting, progress, recordCount, recordPagination, selectedFileCount]);
}
