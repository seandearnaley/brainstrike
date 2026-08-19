import { databaseQueryTelemetry } from '@brainstrike/db';
import { useEffect, useRef } from 'react';
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
  recordArrayRetention: DatabaseDemoRecordArrayRetentionSnapshot;
  recordIds: string[];
}

interface DatabaseDemoRecordArrayRetentionSnapshot {
  aliveGenerations: number[];
  collectedGenerationCount: number;
  currentGeneration: number | null;
  droppedGenerationCount: number;
  trackedGenerationCount: number;
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
  readonly recordPageSize: number;
  readonly records: readonly { readonly id: string }[];
  readonly recordTotalRecords: number;
}

const MAX_TEST_RECORD_IDS = 100;
const MAX_TEST_RECORD_ARRAY_GENERATIONS = 256;

interface RecordArrayGenerationReference {
  readonly generation: number;
  readonly reference: WeakRef<readonly { readonly id: string }[]>;
}

interface RecordArrayRetentionTracker {
  currentGeneration: number | null;
  droppedGenerationCount: number;
  lastReference: WeakRef<readonly { readonly id: string }[]> | null;
  nextGeneration: number;
  readonly references: RecordArrayGenerationReference[];
}

function createRecordArrayRetentionTracker(): RecordArrayRetentionTracker {
  return {
    currentGeneration: null,
    droppedGenerationCount: 0,
    lastReference: null,
    nextGeneration: 1,
    references: [],
  };
}

export function createRecordArrayWeakReference(
  records: readonly { readonly id: string }[]
): WeakRef<readonly { readonly id: string }[]> {
  if (typeof WeakRef !== 'function') {
    throw new Error('Database memory test diagnostics require WeakRef support.');
  }
  return new WeakRef(records);
}

function trackRecordArrayGeneration(
  tracker: RecordArrayRetentionTracker,
  records: readonly { readonly id: string }[]
): number | null {
  if (records.length === 0) {
    tracker.currentGeneration = null;
    tracker.lastReference = null;
    return null;
  }
  if (tracker.lastReference?.deref() === records) {
    return tracker.currentGeneration;
  }

  const generation = tracker.nextGeneration;
  tracker.nextGeneration += 1;
  const reference = createRecordArrayWeakReference(records);
  tracker.references.push({ generation, reference });
  tracker.lastReference = reference;
  tracker.currentGeneration = generation;
  if (tracker.references.length > MAX_TEST_RECORD_ARRAY_GENERATIONS) {
    tracker.references.shift();
    tracker.droppedGenerationCount += 1;
  }
  return generation;
}

function snapshotRecordArrayRetention(
  tracker: RecordArrayRetentionTracker,
  currentGeneration: number | null
): DatabaseDemoRecordArrayRetentionSnapshot {
  const aliveGenerations = tracker.references
    .filter((entry) => entry.reference.deref() !== undefined)
    .map((entry) => entry.generation);
  return {
    aliveGenerations,
    collectedGenerationCount: tracker.references.length - aliveGenerations.length,
    currentGeneration,
    droppedGenerationCount: tracker.droppedGenerationCount,
    trackedGenerationCount: tracker.references.length,
  };
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
  getCacheDiagnostics,
  isImporting,
  recordCount,
  recordCurrentPage,
  recordPageSize,
  records,
  recordTotalRecords,
}: UseDatabaseDemoTestHookOptions): void {
  const recordArrayRetentionTrackerRef = useRef<RecordArrayRetentionTracker | null>(null);
  useEffect(() => {
    if (!window.desktopLifecycle?.isTestMode) {
      return;
    }

    const tracker = recordArrayRetentionTrackerRef.current ?? createRecordArrayRetentionTracker();
    recordArrayRetentionTrackerRef.current = tracker;
    const currentGeneration = trackRecordArrayGeneration(tracker, records);
    const recordIds = records.slice(0, MAX_TEST_RECORD_IDS).map((record) => record.id);

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
          recordArrayRetention: snapshotRecordArrayRetention(tracker, currentGeneration),
          recordIds,
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
    records,
    recordTotalRecords,
  ]);
}
