import { JobQueue, usePGliteDatabase, useVectorEnabled } from '@brainstrike/db';
import { useVectorPreferencesStore, useVectorStatusUIStore } from '@brainstrike/preferences';
import type { QueueAdapter } from '@brainstrike/queue';
import { useToast } from '@brainstrike/ui';
import { useCallback, useMemo, useRef } from 'react';
import { EmbeddingActionsDropdown } from './embedding-actions-dropdown';
import { EmbeddingQueueProvider } from './embedding-queue-provider';
import { EmbeddingStatusBar } from './embedding-status-bar';
import { getBackfillDisabledState } from './vector-status/backfill-utils';
import { useEmbeddingWorkerControls } from './vector-status/use-embedding-worker-controls';
import { useVectorQueueState } from './vector-status/use-vector-queue-state';
import { createVectorQueueService } from './vector-status/vector-queue-service';

export interface EmbeddingControlsPanelProps {
  /** The embedding queue adapter (passed from app) */
  embeddingQueue?: QueueAdapter | null;
  /** Chunk repository with coverage methods */
  chunkRepository?: {
    getCoverageForSet: (
      setId: string
    ) => Promise<{ totalChunks: number; chunksWithEmbeddingsForSet: number }>;
    clearEmbeddingsForSet: (embeddingSetId: string) => Promise<number>;
  } | null;
  /** Whether to show the status bar (default: true) */
  showStatusBar?: boolean;
  /** Additional className for the container */
  className?: string;
}

/**
 * Detect if running in Electron renderer
 */
function isElectronRenderer(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const w = window as unknown as { electronAPI?: unknown };
  return !!w.electronAPI;
}

/**
 * Determine worker status from various state flags
 */
function getWorkerStatus(
  queueCounts: { failed: number; running: number },
  startWorkerError: string | null,
  startingWorker: boolean,
  workerLocalRunning: boolean,
  throughput: number
): 'running' | 'error' | 'disabled' | 'initializing' {
  const isWeb =
    typeof window !== 'undefined' && !(window as { electronAPI?: unknown })?.electronAPI;
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
 * Inner component that consumes the embedding queue context
 */
function EmbeddingControlsPanelContent({
  chunkRepository,
  showStatusBar = true,
  className,
}: Omit<EmbeddingControlsPanelProps, 'embeddingQueue'>) {
  const { toast } = useToast();
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
  const needsWorkerStart =
    isWebPlatform && !workerControls.workerLocalRunning && !workerControls.startingWorker;

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

    // Auto-start worker on web if not running
    if (isWebPlatform && !workerControls.workerLocalRunning) {
      await workerControls.startWorker();
    }

    // Run backfill
    await backfillRef.current();
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

  return (
    <div className={className}>
      {/* Embedding Actions Dropdown */}
      <div className="flex items-center">
        <EmbeddingActionsDropdown
          backfilling={queueState.backfilling}
          backfillProgress={queueState.backfillProgress}
          coverage={queueState.coverage}
          disabled={backfillDisabled}
          disabledReason={disabledReason}
          failedCount={queueState.queueCounts.failed}
          hasDb={hasDb}
          onBackfill={handleBackfillWithWorkerStart}
          onClearQueue={queueState.clearQueue}
          onRetryFailed={queueState.retryFailed}
          onWipeQueue={queueState.wipeQueue}
          queueCounts={queueState.queueCounts}
          startingWorker={workerControls.startingWorker}
          willAutoStartWorker={needsWorkerStart}
        />
      </div>

      {/* Embedding Status Bar */}
      {showStatusBar && (
        <EmbeddingStatusBar
          latencyStats={queueState.latencyStats}
          queueCounts={queueState.queueCounts}
          telemetryTrend={queueState.telemetryTrend}
          throughput={queueState.throughput}
          vectorEnabled={vectorEnabled}
          workerStatus={workerStatus}
        />
      )}
    </div>
  );
}

/**
 * EmbeddingControlsPanel - Self-contained embedding controls with status bar.
 *
 * This component wraps the EmbeddingActionsDropdown and EmbeddingStatusBar
 * with all necessary hooks and state management. It provides a clean integration
 * point for adding embedding controls to any panel.
 *
 * Key features:
 * - Split button for Backfill/Retry/Clear/Wipe actions
 * - Compact status bar with queue metrics and sparklines
 * - Auto-starts worker on web platform when backfill is clicked
 * - Validates API key availability before embedding
 * - Shows PG and worker status badges
 */
export function EmbeddingControlsPanel({
  embeddingQueue = null,
  chunkRepository = null,
  showStatusBar = true,
  className,
}: EmbeddingControlsPanelProps) {
  return (
    <EmbeddingQueueProvider {...(embeddingQueue ? { adapter: embeddingQueue } : {})}>
      <EmbeddingControlsPanelContent
        chunkRepository={chunkRepository}
        showStatusBar={showStatusBar}
        {...(className ? { className } : {})}
      />
    </EmbeddingQueueProvider>
  );
}
