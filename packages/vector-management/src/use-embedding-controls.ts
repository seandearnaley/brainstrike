import { JobQueue, usePGliteDatabase, useVectorEnabled } from '@brainstrike/db';
import { useVectorPreferencesStore, useVectorStatusUIStore } from '@brainstrike/preferences';
// Import types to ensure global Window augmentation is available
import '@brainstrike/types';
import { useCallback, useMemo, useRef } from 'react';
import type { EmbeddingActionsDropdownProps } from './embedding-actions-dropdown';
import type { EmbeddingStatusBarProps } from './embedding-status-bar';
import { getBackfillDisabledState } from './vector-status/backfill-utils';
import { useEmbeddingWorkerControls } from './vector-status/use-embedding-worker-controls';
import { useVectorQueueState } from './vector-status/use-vector-queue-state';
import { createVectorQueueService } from './vector-status/vector-queue-service';

export interface UseEmbeddingControlsOptions {
  /** Chunk repository with coverage methods */
  chunkRepository: {
    getCoverageForSet: (
      setId: string
    ) => Promise<{ totalChunks: number; chunksWithEmbeddingsForSet: number }>;
    clearEmbeddingsForSet: (embeddingSetId: string) => Promise<number>;
  } | null;
  /** Toast function for notifications */
  toast: (options: { title: string; description?: string; variant?: 'destructive' }) => void;
}

export interface UseEmbeddingControlsResult {
  /** Props for rendering EmbeddingActionsDropdown */
  dropdownProps: EmbeddingActionsDropdownProps;
  /** Whether the database is available */
  hasDb: boolean;
  /** Props for rendering EmbeddingStatusBar */
  statusBarProps: EmbeddingStatusBarProps;
}

/**
 * Detect if running in Electron renderer.
 * Uses the global Window augmentation from @brainstrike/types.
 */
function isElectronRenderer(): boolean {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
}

/**
 * Determine worker status from various state flags.
 * Uses the global Window augmentation from @brainstrike/types.
 */
function getWorkerStatus(
  queueCounts: { failed: number; running: number },
  startWorkerError: string | null,
  startingWorker: boolean,
  workerLocalRunning: boolean,
  throughput: number
): 'running' | 'error' | 'disabled' | 'initializing' {
  const isWeb = typeof window !== 'undefined' && window.electronAPI === undefined;
  if (queueCounts.failed > 0 || startWorkerError) {
    return 'error';
  }
  if (startingWorker) {
    return 'initializing';
  }
  if (workerLocalRunning || queueCounts.running > 0 || throughput > 0) {
    return 'running';
  }
  return isWeb ? 'disabled' : 'initializing';
}

/**
 * Hook that provides all state and props for embedding controls.
 *
 * This hook extracts the state management logic that was previously in
 * EmbeddingControlsPanelContent, allowing consumers to render the
 * EmbeddingActionsDropdown and EmbeddingStatusBar components in
 * separate locations while sharing the same state.
 *
 * @example
 * ```tsx
 * function MyPanel({ chunkRepository }) {
 *   const { toast } = useToast();
 *   const { dropdownProps, statusBarProps } = useEmbeddingControls({
 *     chunkRepository,
 *     toast,
 *   });
 *
 *   return (
 *     <div>
 *       <div className="toolbar">
 *         <Button>Import</Button>
 *         <EmbeddingActionsDropdown {...dropdownProps} />
 *       </div>
 *       <EmbeddingStatusBar {...statusBarProps} />
 *     </div>
 *   );
 * }
 * ```
 */
export function useEmbeddingControls({
  chunkRepository,
  toast,
}: UseEmbeddingControlsOptions): UseEmbeddingControlsResult {
  const db = usePGliteDatabase();
  const vectorEnabled = useVectorEnabled();

  // Get active collection from shared store
  const activeId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);
  const isImporting = useVectorStatusUIStore((s) => s.isImporting);
  const isEmbeddingActive = useVectorStatusUIStore((s) => s.isEmbeddingActive);

  // Get device preferences
  const devicePref = useVectorPreferencesStore((s) => s.devicePref);
  const reinitEveryN = useVectorPreferencesStore((s) => s.reinitEveryN);

  // Create vector queue service
  const service = useMemo(() => {
    if (!(db && chunkRepository)) {
      return null;
    }
    return createVectorQueueService({
      db,
      jobQueue: new JobQueue(db),
      chunkRepository,
    });
  }, [db, chunkRepository]);

  // Refs for backfill and validation callbacks
  const backfillRef = useRef<() => Promise<void>>(async () => {});
  const validateApiKeyRef = useRef<() => Promise<{ valid: boolean; message?: string }>>(
    async () => ({ valid: true })
  );

  // Callback that validates API key before backfill
  const invokeBackfill = useCallback(async () => {
    const validation = await validateApiKeyRef.current();
    if (!validation.valid) {
      toast({
        title: 'API Key Required',
        description: validation.message ?? 'Please configure your API key before embedding.',
        variant: 'destructive',
      });
      return;
    }
    await backfillRef.current();
  }, [toast]);

  // Worker controls (start/stop/reset)
  const workerControls = useEmbeddingWorkerControls({
    db,
    devicePreference: devicePref,
    reinitEveryN,
    activeEmbeddingSetId: activeId,
    onBackfill: invokeBackfill,
    toast,
  });

  // Queue state (coverage, counts, throughput, latency, etc.)
  const queueState = useVectorQueueState({
    service,
    activeEmbeddingSetId: activeId,
    shouldAutoBackfill: workerControls.workerLocalRunning,
    isImporting,
    isEmbeddingActive,
  });

  // Update refs
  backfillRef.current = queueState.backfillActiveSet;
  validateApiKeyRef.current = queueState.validateApiKey;

  // Determine if we need to auto-start worker (web platform only)
  const isWebPlatform = typeof window !== 'undefined' && !isElectronRenderer();
  const isDesktopPlatform = typeof window !== 'undefined' && isElectronRenderer();
  const needsWorkerStart =
    isWebPlatform && !workerControls.workerLocalRunning && !workerControls.startingWorker;
  const dropdownStartingWorker =
    !(queueState.backfilling || isDesktopPlatform) && workerControls.startingWorker;

  // Combined backfill handler that auto-starts worker on web
  const handleBackfillWithWorkerStart = useCallback(async () => {
    if (!service) {
      toast({
        title: 'Database Not Ready',
        description:
          'The vector queue service is not available. Try switching tabs or restarting the app.',
        variant: 'destructive',
      });
      return;
    }

    if (!activeId) {
      toast({
        title: 'No Collection Selected',
        description: 'Please select an embedding collection before backfilling.',
        variant: 'destructive',
      });
      return;
    }

    // Validate API key
    const validation = await validateApiKeyRef.current();
    if (!validation.valid) {
      toast({
        title: 'API Key Required',
        description: validation.message ?? 'Please configure your API key before embedding.',
        variant: 'destructive',
      });
      return;
    }

    try {
      // Auto-start worker on web if not running
      if (isWebPlatform && !workerControls.workerLocalRunning) {
        await workerControls.startWorker();
      }

      // Run backfill
      await backfillRef.current();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Backfill Failed',
        description: message,
        variant: 'destructive',
      });
      throw error;
    }
  }, [toast, isWebPlatform, workerControls, service, activeId]);

  // Get disabled state for backfill button
  const { disabled: backfillDisabled, title: disabledReason } = getBackfillDisabledState({
    activeId,
    hasDb: Boolean(db),
    backfilling: queueState.backfilling,
    coverage: queueState.coverage,
    queueCounts: queueState.queueCounts,
  });

  // Worker status for status bar
  const workerStatus = getWorkerStatus(
    queueState.queueCounts,
    workerControls.startWorkerError,
    workerControls.startingWorker,
    workerControls.workerLocalRunning,
    queueState.throughput
  );

  const hasDb = Boolean(db);

  // Props for the actions dropdown
  const dropdownProps: EmbeddingActionsDropdownProps = {
    backfilling: queueState.backfilling,
    backfillProgress: queueState.backfillProgress,
    coverage: queueState.coverage,
    disabled: backfillDisabled,
    disabledReason,
    failedCount: queueState.queueCounts.failed,
    hasDb,
    onBackfill: handleBackfillWithWorkerStart,
    onClearQueue: queueState.clearQueue,
    onRetryFailed: queueState.retryFailed,
    onWipeQueue: queueState.wipeQueue,
    queueCounts: queueState.queueCounts,
    startingWorker: dropdownStartingWorker,
    willAutoStartWorker: needsWorkerStart,
  };

  // Props for the status bar
  const statusBarProps: EmbeddingStatusBarProps = {
    latencyStats: queueState.latencyStats,
    queueCounts: queueState.queueCounts,
    telemetryTrend: queueState.telemetryTrend,
    throughput: queueState.throughput,
    vectorEnabled,
    workerStatus,
  };

  return {
    dropdownProps,
    statusBarProps,
    hasDb,
  };
}
