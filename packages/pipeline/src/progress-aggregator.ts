/**
 * @module pipeline/progress-aggregator
 *
 * Unified progress aggregation across all pipeline stages.
 *
 * This module provides a centralized progress tracker that combines updates from
 * the streaming, chunking, and embedding stages into a unified `PipelineProgress`
 * model.
 *
 * ## Design Principles
 *
 * 1. **Incremental Updates**: Each stage reports progress independently
 * 2. **Error Tracking**: Recent errors are collected for diagnostics
 * 3. **Retry-Aware**: Progress remains accurate under retries (via dedupe)
 * 4. **Throttled Callbacks**: Configurable throttling to prevent UI overload
 *
 * @example
 * ```typescript
 * const aggregator = createProgressAggregator({
 *   onProgress: (progress) => console.log(progress),
 *   throttleMs: 100,
 * });
 *
 * aggregator.setTotals({ files: 100, chunks: 500 });
 * aggregator.reportImportProgress({ completed: 1, currentItem: 'file.ts' });
 * aggregator.reportChunkingProgress({ completed: 5, currentItem: 'file.ts' });
 * aggregator.reportError('chunking', 'file.ts', 'Parse error');
 *
 * const snapshot = aggregator.getSnapshot();
 * ```
 */

import type { PipelineProgress, StageProgress } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for creating a progress aggregator.
 */
export interface ProgressAggregatorConfig {
  /** Maximum number of recent errors to retain */
  maxRecentErrors?: number;
  /** Callback invoked when progress changes */
  onProgress?: ProgressCallback;
  /** Throttle interval for progress callbacks (ms) */
  throttleMs?: number;
}

/**
 * Progress callback signature.
 */
export type ProgressCallback = (progress: PipelineProgress) => void;

/**
 * Initial totals for the pipeline run.
 */
export interface PipelineTotals {
  /** Total chunks to process (may be updated as chunking progresses) */
  chunks?: number;
  /** Total embedding jobs (may be updated as jobs are enqueued) */
  embeddings?: number;
  /** Total files to import */
  files: number;
}

/**
 * Stage update payload.
 */
export interface StageUpdate {
  /** Items completed */
  completed?: number;
  /** Current item being processed */
  currentItem?: string;
  /** Items failed */
  failed?: number;
  /** Items currently in progress */
  inProgress?: number;
  /** Update total (for chunks/embeddings that are discovered during processing) */
  total?: number;
}

/**
 * Error entry for tracking.
 */
export interface PipelineError {
  error: string;
  item: string;
  stage: 'import' | 'chunking' | 'embedding';
  timestamp: string;
}

/**
 * The progress aggregator interface.
 */
export interface ProgressAggregator {
  /**
   * Mark the pipeline as complete.
   */
  complete: () => void;

  /**
   * Mark the pipeline as failed.
   */
  fail: (error: string) => void;

  /**
   * Force emit the current progress (bypasses throttle).
   */
  flush: () => void;

  /**
   * Get the current progress snapshot.
   */
  getSnapshot: () => PipelineProgress;

  /**
   * Report progress from the chunking stage.
   */
  reportChunkingProgress: (update: StageUpdate) => void;

  /**
   * Report progress from the embedding stage.
   */
  reportEmbeddingProgress: (update: StageUpdate) => void;

  /**
   * Report an error from any stage.
   */
  reportError: (stage: PipelineError['stage'], item: string, error: string) => void;

  /**
   * Report progress from the import stage.
   */
  reportImportProgress: (update: StageUpdate) => void;

  /**
   * Reset the aggregator for a new run.
   */
  reset: () => void;
  /**
   * Set initial totals for the pipeline run.
   * Can be called multiple times as totals become known.
   */
  setTotals: (totals: Partial<PipelineTotals>) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_THROTTLE_MS = 100;
const DEFAULT_MAX_RECENT_ERRORS = 10;

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a progress aggregator instance.
 *
 * @param config - Aggregator configuration
 * @returns A configured progress aggregator
 */
export function createProgressAggregator(
  config: ProgressAggregatorConfig = {}
): ProgressAggregator {
  const {
    onProgress,
    throttleMs = DEFAULT_THROTTLE_MS,
    maxRecentErrors = DEFAULT_MAX_RECENT_ERRORS,
  } = config;

  // Internal mutable state type (allows undefined for currentItem)
  interface MutableStageProgress {
    completed: number;
    currentItem: string | undefined;
    failed: number;
    inProgress: number;
    total: number;
  }

  // Internal state
  let phase: PipelineProgress['phase'] = 'importing';
  let startedAt = new Date().toISOString();
  let completedAt: string | undefined;
  let lastEmitTime = 0;

  const stages: Record<'import' | 'chunking' | 'embedding', MutableStageProgress> = {
    chunking: createEmptyMutableStage(),
    embedding: createEmptyMutableStage(),
    import: createEmptyMutableStage(),
  };

  const recentErrors: PipelineError[] = [];

  // -------------------------------------------------------------------------
  // Stage Helpers
  // -------------------------------------------------------------------------

  function createEmptyMutableStage(): MutableStageProgress {
    return {
      completed: 0,
      currentItem: undefined,
      failed: 0,
      inProgress: 0,
      total: 0,
    };
  }

  function toStageProgress(mutable: MutableStageProgress): StageProgress {
    const result: StageProgress = {
      completed: mutable.completed,
      failed: mutable.failed,
      inProgress: mutable.inProgress,
      total: mutable.total,
    };
    if (mutable.currentItem !== undefined) {
      result.currentItem = mutable.currentItem;
    }
    return result;
  }

  function updateStage(stageName: 'import' | 'chunking' | 'embedding', update: StageUpdate): void {
    const stage = stages[stageName];

    if (update.total !== undefined) {
      stage.total = update.total;
    }
    if (update.completed !== undefined) {
      stage.completed = update.completed;
    }
    if (update.inProgress !== undefined) {
      stage.inProgress = update.inProgress;
    }
    if (update.failed !== undefined) {
      stage.failed = update.failed;
    }
    if (update.currentItem !== undefined) {
      stage.currentItem = update.currentItem;
    } else if (update.completed !== undefined) {
      // Clear current item when reporting completion without a new item
      stage.currentItem = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Phase Detection
  // -------------------------------------------------------------------------

  function detectPhase(): PipelineProgress['phase'] {
    // Already in terminal state
    if (phase === 'complete' || phase === 'error') {
      return phase;
    }

    // Check if embedding is active
    if (stages.embedding.inProgress > 0 || stages.embedding.completed > 0) {
      return 'embedding';
    }

    // Check if chunking is active
    if (stages.chunking.inProgress > 0 || stages.chunking.completed > 0) {
      return 'chunking';
    }

    // Default to importing
    return 'importing';
  }

  // -------------------------------------------------------------------------
  // Progress Emission
  // -------------------------------------------------------------------------

  function buildSnapshot(): PipelineProgress {
    const snapshot: PipelineProgress = {
      chunking: toStageProgress(stages.chunking),
      embedding: toStageProgress(stages.embedding),
      import: toStageProgress(stages.import),
      phase,
      recentErrors: [...recentErrors],
      startedAt,
    };

    // Conditionally add optional properties
    if (completedAt !== undefined) {
      snapshot.completedAt = completedAt;
    }

    return snapshot;
  }

  function maybeEmit(): void {
    if (!onProgress) {
      return;
    }

    const now = Date.now();
    if (now - lastEmitTime >= throttleMs) {
      lastEmitTime = now;
      onProgress(buildSnapshot());
    }
  }

  function forceEmit(): void {
    if (onProgress) {
      lastEmitTime = Date.now();
      onProgress(buildSnapshot());
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function setTotals(totals: Partial<PipelineTotals>): void {
    if (totals.files !== undefined) {
      stages.import.total = totals.files;
    }
    if (totals.chunks !== undefined) {
      stages.chunking.total = totals.chunks;
    }
    if (totals.embeddings !== undefined) {
      stages.embedding.total = totals.embeddings;
    }
    maybeEmit();
  }

  function reportImportProgress(update: StageUpdate): void {
    updateStage('import', update);
    phase = detectPhase();
    maybeEmit();
  }

  function reportChunkingProgress(update: StageUpdate): void {
    updateStage('chunking', update);
    phase = detectPhase();
    maybeEmit();
  }

  function reportEmbeddingProgress(update: StageUpdate): void {
    updateStage('embedding', update);
    phase = detectPhase();
    maybeEmit();
  }

  function reportError(stage: PipelineError['stage'], item: string, error: string): void {
    const entry: PipelineError = {
      error,
      item,
      stage,
      timestamp: new Date().toISOString(),
    };

    recentErrors.push(entry);

    // Trim to max size
    while (recentErrors.length > maxRecentErrors) {
      recentErrors.shift();
    }

    // Increment failed count for the stage
    stages[stage].failed++;

    maybeEmit();
  }

  function complete(): void {
    phase = 'complete';
    completedAt = new Date().toISOString();
    forceEmit();
  }

  function fail(error: string): void {
    phase = 'error';
    completedAt = new Date().toISOString();

    // Add the final error
    recentErrors.push({
      error,
      item: 'pipeline',
      stage: detectActiveStage(),
      timestamp: completedAt,
    });

    forceEmit();
  }

  function detectActiveStage(): PipelineError['stage'] {
    if (stages.embedding.inProgress > 0) {
      return 'embedding';
    }
    if (stages.chunking.inProgress > 0) {
      return 'chunking';
    }
    return 'import';
  }

  function getSnapshot(): PipelineProgress {
    return buildSnapshot();
  }

  function reset(): void {
    phase = 'importing';
    startedAt = new Date().toISOString();
    completedAt = undefined;
    lastEmitTime = 0;

    stages.import = createEmptyMutableStage();
    stages.chunking = createEmptyMutableStage();
    stages.embedding = createEmptyMutableStage();

    recentErrors.length = 0;

    maybeEmit();
  }

  function flush(): void {
    forceEmit();
  }

  return {
    complete,
    fail,
    flush,
    getSnapshot,
    reportChunkingProgress,
    reportEmbeddingProgress,
    reportError,
    reportImportProgress,
    reset,
    setTotals,
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Calculate overall completion percentage from a pipeline progress snapshot.
 *
 * @param progress - Pipeline progress snapshot
 * @returns Percentage (0-100)
 */
export function calculateOverallPercentage(progress: PipelineProgress): number {
  const { import: imp, chunking, embedding } = progress;

  // Weight each stage equally for simplicity
  // In practice, embedding is often the longest stage
  const weights = { chunking: 0.3, embedding: 0.5, import: 0.2 };

  const importPct = imp.total > 0 ? (imp.completed / imp.total) * 100 : 0;
  const chunkingPct = chunking.total > 0 ? (chunking.completed / chunking.total) * 100 : 0;
  const embeddingPct = embedding.total > 0 ? (embedding.completed / embedding.total) * 100 : 0;

  return (
    importPct * weights.import + chunkingPct * weights.chunking + embeddingPct * weights.embedding
  );
}

/**
 * Check if the pipeline has any failures.
 *
 * @param progress - Pipeline progress snapshot
 * @returns True if any stage has failures
 */
export function hasFailures(progress: PipelineProgress): boolean {
  return (
    progress.import.failed > 0 || progress.chunking.failed > 0 || progress.embedding.failed > 0
  );
}

/**
 * Get total items across all stages.
 *
 * @param progress - Pipeline progress snapshot
 * @returns Object with total, completed, and failed counts
 */
export function getTotalCounts(progress: PipelineProgress): {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
} {
  const { import: imp, chunking, embedding } = progress;

  return {
    completed: imp.completed + chunking.completed + embedding.completed,
    failed: imp.failed + chunking.failed + embedding.failed,
    inProgress: imp.inProgress + chunking.inProgress + embedding.inProgress,
    total: imp.total + chunking.total + embedding.total,
  };
}

/**
 * Format a pipeline progress snapshot for display.
 *
 * @param progress - Pipeline progress snapshot
 * @returns Human-readable progress string
 */
export function formatProgress(progress: PipelineProgress): string {
  const { phase, import: imp, chunking, embedding } = progress;

  const parts: string[] = [`Phase: ${phase}`];

  if (imp.total > 0) {
    parts.push(`Import: ${imp.completed}/${imp.total}`);
  }
  if (chunking.total > 0) {
    parts.push(`Chunking: ${chunking.completed}/${chunking.total}`);
  }
  if (embedding.total > 0) {
    parts.push(`Embedding: ${embedding.completed}/${embedding.total}`);
  }

  const pct = calculateOverallPercentage(progress);
  parts.push(`(${pct.toFixed(1)}%)`);

  return parts.join(' | ');
}
