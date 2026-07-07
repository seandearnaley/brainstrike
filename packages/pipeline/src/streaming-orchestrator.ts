/**
 * @module pipeline/streaming-orchestrator
 *
 * Streaming import orchestrator for memory-efficient file processing.
 *
 * This module implements a backpressure-based pipeline that processes files
 * one-at-a-time (or in small batches), avoiding the memory overhead of
 * loading all file contents upfront.
 *
 * ## Design Principles
 *
 * 1. **Lazy Loading**: Content is read on-demand via ContentReader
 * 2. **Backpressure**: Process → release → next prevents memory accumulation
 * 3. **Error Isolation**: Individual file failures don't halt the pipeline
 * 4. **Progress Tracking**: Real-time progress with throttled updates
 *
 * @example
 * ```typescript
 * const reader: ContentReader = {
 *   async readContent(key) {
 *     return await fs.readFile(extractPath(key), 'utf-8');
 *   },
 *   releaseContent(key) {
 *     // Allow GC of content cache
 *   }
 * };
 *
 * const result = await streamingImport({
 *   compositeKeys: ['folder:file1.ts', 'folder:file2.ts'],
 *   contentReader: reader,
 *   processFile: async (key, content) => ({ chunksCreated: 5 }),
 *   options: { concurrency: 1 },
 *   onProgress: (progress) => console.log(progress),
 * });
 * ```
 */

import type {
  ContentReader,
  FileId,
  StreamingFileResult,
  StreamingImportOptions,
  StreamingImportResult,
} from './types.js';

// =============================================================================
// STREAMING ORCHESTRATOR TYPES
// =============================================================================

/**
 * Result from processing a single file.
 * Returned by the processFile callback.
 */
export interface FileProcessResult {
  /** Number of chunks created */
  chunksCreated: number;
  /** Error message if processing failed */
  error?: string;
  /** Whether file already existed in the database */
  existed?: boolean;
  /** Assigned file ID (if import created a new record) */
  fileId?: FileId;
  /** Number of embedding jobs enqueued */
  jobsEnqueued: number;
  /** Whether the file was successfully processed */
  success: boolean;
}

/**
 * Callback to process a single file's content.
 * This is where import + chunking + job enqueueing happens.
 */
export type ProcessFileCallback = (
  compositeKey: string,
  content: string
) => Promise<FileProcessResult>;

/**
 * Progress callback for streaming updates.
 */
export type StreamingProgressCallback = (progress: StreamingProgress) => void;

/**
 * Progress state during streaming import.
 */
export interface StreamingProgress {
  /** Files completed (success or failure) */
  completed: number;
  /** Current file being processed */
  currentFile?: string;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Files that failed */
  failed: number;
  /** Files currently being processed */
  inProgress: number;
  /** Estimated completion percentage */
  percentage: number;
  /** Total files to process */
  total: number;
}

/**
 * Input to the streaming import orchestrator.
 */
export interface StreamingImportInput {
  /** Composite keys of files to process (folderId:path format) */
  compositeKeys: string[];
  /** Content reader for lazy loading */
  contentReader: ContentReader;
  /** Progress callback (throttled) */
  onProgress?: StreamingProgressCallback;
  /** Import options */
  options?: StreamingImportOptions;
  /** Callback to process each file */
  processFile: ProcessFileCallback;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

// =============================================================================
// DEFAULT OPTIONS
// =============================================================================

const DEFAULT_OPTIONS: Required<StreamingImportOptions> = {
  concurrency: 1, // Sequential by default for minimum memory
  continueOnError: true, // Isolate errors to individual files
  prefetchAhead: 0, // No prefetch by default
  progressThrottleMs: 100, // 100ms throttle for progress updates
};

// =============================================================================
// PROGRESS TRACKER
// =============================================================================

/**
 * Tracks and emits progress updates with throttling.
 */
class ProgressTracker {
  private completed = 0;
  private failed = 0;
  private inProgress = 0;
  private lastEmitTime = 0;

  constructor(
    private readonly total: number,
    private readonly startTime: number,
    private readonly throttleMs: number,
    private readonly onProgress?: StreamingProgressCallback
  ) {}

  startFile(): void {
    this.inProgress++;
  }

  completeFile(hadError: boolean): void {
    this.completed++;
    this.inProgress--;
    if (hadError) {
      this.failed++;
    }
  }

  emit(currentFile?: string): void {
    const now = Date.now();
    const shouldEmit = this.onProgress && now - this.lastEmitTime >= this.throttleMs;

    if (shouldEmit) {
      this.lastEmitTime = now;
      this.onProgress?.({
        completed: this.completed,
        failed: this.failed,
        inProgress: this.inProgress,
        total: this.total,
        ...(currentFile === undefined ? {} : { currentFile }),
        elapsedMs: now - this.startTime,
        percentage: this.total > 0 ? (this.completed / this.total) * 100 : 0,
      });
    }
  }

  emitFinal(): void {
    this.onProgress?.({
      completed: this.completed,
      elapsedMs: Date.now() - this.startTime,
      failed: this.failed,
      inProgress: 0,
      percentage: this.total > 0 ? (this.completed / this.total) * 100 : 100,
      total: this.total,
    });
  }

  get failedCount(): number {
    return this.failed;
  }
}

// =============================================================================
// STREAMING ORCHESTRATOR IMPLEMENTATION
// =============================================================================

/**
 * Execute a streaming import with backpressure.
 *
 * This function processes files one-at-a-time (or with limited concurrency),
 * loading content on-demand and releasing it after processing to enable
 * garbage collection.
 *
 * @param input - Streaming import configuration
 * @returns Aggregated results from all file processing
 */
export async function streamingImport(input: StreamingImportInput): Promise<StreamingImportResult> {
  const { compositeKeys, options = {}, onProgress, signal } = input;
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const startTime = Date.now();

  // Early abort check
  if (signal?.aborted) {
    return buildEmptyResult(compositeKeys.length, startTime);
  }

  const tracker = new ProgressTracker(
    compositeKeys.length,
    startTime,
    mergedOptions.progressThrottleMs,
    onProgress
  );

  const results =
    mergedOptions.concurrency === 1
      ? await processSequentially(input, mergedOptions, tracker)
      : await processConcurrently(input, mergedOptions, tracker);

  tracker.emitFinal();
  return buildResult(results, startTime);
}

// =============================================================================
// SEQUENTIAL PROCESSING
// =============================================================================

/**
 * Process files one at a time (concurrency = 1).
 */
async function processSequentially(
  input: StreamingImportInput,
  options: Required<StreamingImportOptions>,
  tracker: ProgressTracker
): Promise<StreamingFileResult[]> {
  const { compositeKeys, contentReader, processFile, signal } = input;
  const results: StreamingFileResult[] = [];

  for (const compositeKey of compositeKeys) {
    if (signal?.aborted) {
      break;
    }

    tracker.startFile();
    tracker.emit(compositeKey);

    const result = await processOneFile(compositeKey, contentReader, processFile);
    results.push(result);

    tracker.completeFile(Boolean(result.error));
    tracker.emit();

    if (!options.continueOnError && result.error) {
      break;
    }
  }

  return results;
}

// =============================================================================
// CONCURRENT PROCESSING
// =============================================================================

/**
 * Process files with limited concurrency.
 */
async function processConcurrently(
  input: StreamingImportInput,
  options: Required<StreamingImportOptions>,
  tracker: ProgressTracker
): Promise<StreamingFileResult[]> {
  const { compositeKeys, contentReader, processFile, signal } = input;
  const { concurrency, prefetchAhead, continueOnError } = options;

  const results: StreamingFileResult[] = [];
  let index = 0;
  let shouldStop = false;

  const processNext = async (): Promise<void> => {
    while (!shouldStop && index < compositeKeys.length) {
      if (signal?.aborted) {
        return;
      }

      const currentIndex = index++;
      const compositeKey = compositeKeys[currentIndex];

      if (!compositeKey) {
        return;
      }

      tracker.startFile();
      tracker.emit(compositeKey);

      maybePrefetch(contentReader, compositeKeys, currentIndex, prefetchAhead);

      const result = await processOneFile(compositeKey, contentReader, processFile);
      results.push(result);

      tracker.completeFile(Boolean(result.error));
      tracker.emit();

      if (!continueOnError && result.error) {
        shouldStop = true;
        return;
      }
    }
  };

  const workerCount = Math.min(concurrency, compositeKeys.length);
  const workers = Array.from({ length: workerCount }, () => processNext());
  await Promise.all(workers);

  return results;
}

/**
 * Trigger prefetch for upcoming files if configured.
 */
function maybePrefetch(
  contentReader: ContentReader,
  compositeKeys: string[],
  currentIndex: number,
  prefetchAhead: number
): void {
  if (prefetchAhead <= 0 || !contentReader.prefetchBatch) {
    return;
  }

  const prefetchKeys = compositeKeys.slice(currentIndex + 1, currentIndex + 1 + prefetchAhead);

  if (prefetchKeys.length > 0) {
    // Fire-and-forget prefetch - errors handled during actual read
    contentReader.prefetchBatch(prefetchKeys).catch(() => {});
  }
}

// =============================================================================
// SINGLE FILE PROCESSING
// =============================================================================

/**
 * Process a single file through the pipeline.
 */
async function processOneFile(
  compositeKey: string,
  contentReader: ContentReader,
  processFile: ProcessFileCallback
): Promise<StreamingFileResult> {
  const fileStart = Date.now();
  const path = extractPathFromCompositeKey(compositeKey);

  try {
    const content = await contentReader.readContent(compositeKey);

    if (content === null) {
      return buildFileError(path, compositeKey, 'Failed to read file content', fileStart);
    }

    const result = await processFile(compositeKey, content);
    releaseContent(contentReader, compositeKey);

    return {
      compositeKey,
      existed: result.existed ?? false,
      imported: result.success,
      path,
      ...(result.fileId === undefined ? {} : { fileId: result.fileId }),
      chunksCreated: result.chunksCreated,
      jobsEnqueued: result.jobsEnqueued,
      ...(result.error === undefined ? {} : { error: result.error }),
      durationMs: Date.now() - fileStart,
    };
  } catch (error) {
    releaseContent(contentReader, compositeKey);
    const message = error instanceof Error ? error.message : String(error);
    return buildFileError(path, compositeKey, message, fileStart);
  }
}

/**
 * Release content to allow garbage collection.
 */
function releaseContent(contentReader: ContentReader, compositeKey: string): void {
  contentReader.releaseContent?.(compositeKey);
}

/**
 * Build an error result for a single file.
 */
function buildFileError(
  path: string,
  compositeKey: string,
  error: string,
  startTime: number
): StreamingFileResult {
  return {
    chunksCreated: 0,
    compositeKey,
    durationMs: Date.now() - startTime,
    error,
    existed: false,
    imported: false,
    jobsEnqueued: 0,
    path,
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Extract the file path from a composite key.
 * Format: "folderId:path" → "path"
 */
function extractPathFromCompositeKey(compositeKey: string): string {
  const colonIndex = compositeKey.indexOf(':');
  return colonIndex === -1 ? compositeKey : compositeKey.slice(colonIndex + 1);
}

/**
 * Build the final result object from individual file results.
 */
function buildResult(results: StreamingFileResult[], startTime: number): StreamingImportResult {
  return {
    durationMs: Date.now() - startTime,
    errorCount: results.filter((r) => r.error).length,
    files: results,
    successCount: results.filter((r) => r.imported).length,
    totalChunks: results.reduce((sum, r) => sum + r.chunksCreated, 0),
    totalFiles: results.length,
    totalJobsEnqueued: results.reduce((sum, r) => sum + r.jobsEnqueued, 0),
  };
}

/**
 * Build an empty result for aborted operations.
 */
function buildEmptyResult(totalFiles: number, startTime: number): StreamingImportResult {
  return {
    durationMs: Date.now() - startTime,
    errorCount: 0,
    files: [],
    successCount: 0,
    totalChunks: 0,
    totalFiles,
    totalJobsEnqueued: 0,
  };
}
