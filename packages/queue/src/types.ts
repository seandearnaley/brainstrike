import type {
  EmbeddingDeviceHint,
  EmbeddingDType,
  EmbedWorkerError,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerSuccess,
} from '@brainstrike/embedding-worker';

export type ProviderDimensionParameter =
  | 'dimensions'
  | 'output_dimensionality'
  | 'output_dimension';

export type EmbedTaskPayload = {
  readonly kind: 'embed';
  readonly id: string;
  readonly model: string;
  readonly texts: readonly string[];
  readonly truncateDim?: number;
  readonly dtype?: EmbeddingDType;
  readonly deviceHint: EmbeddingDeviceHint;
  readonly maxBatchSize?: number;
  readonly provider?: string;
  readonly targetDimension?: number;
  readonly dimensionParameter?: ProviderDimensionParameter;
};

export type TaskPayload = EmbedTaskPayload;

export type QueueAddOptions = {
  readonly priority?: number;
  readonly signal?: AbortSignal;
};

export type QueueAddBulkOptions = {
  readonly priority?: number;
};

export type QueueResult = EmbedWorkerSuccess;

export type QueueProgressEvent = EmbedWorkerProgress;

export type QueueErrorEvent = EmbedWorkerError;

/**
 * Worker client lifecycle states.
 *
 * Standardized state machine for worker readiness per ADR-0002 (BST-165).
 */
export type WorkerClientState = 'initializing' | 'ready' | 'terminated' | 'error';

/**
 * Error types for worker client failures.
 *
 * Provides consistent error categorization across all worker implementations.
 */
export type WorkerClientErrorType =
  | 'initialization_timeout'
  | 'worker_error'
  | 'message_timeout'
  | 'terminated';

/**
 * Structured error for worker client failures.
 */
export type WorkerClientError = {
  readonly type: WorkerClientErrorType;
  readonly message: string;
  readonly cause?: Error;
};

/**
 * Base interface for worker client implementations.
 *
 * Standardizes the common lifecycle patterns found across worker ports
 * (ChunkingWorkerPort, FileTreeWorkerPort, etc.) per ADR-0002.
 *
 * @example
 * ```typescript
 * const worker: WorkerClient = {
 *   isReady: () => ready,
 *   getState: () => state,
 *   terminate: () => { worker.terminate(); state = 'terminated'; },
 * };
 * ```
 *
 * @see docs/adr/0002-queue-boundaries.md
 */
export type WorkerClient = {
  /**
   * Check if the worker is ready to accept messages.
   * Equivalent to `getState() === 'ready'`.
   */
  isReady(): boolean;
  /**
   * Get the current lifecycle state of the worker.
   */
  getState(): WorkerClientState;
  /**
   * Terminate the worker and release all resources.
   * After termination, `getState()` returns 'terminated'.
   */
  terminate(): void;
};

/**
 * Extended worker client with async ready-waiting capability.
 *
 * Use this interface when callers need to wait for worker initialization
 * with timeout support.
 *
 * @example
 * ```typescript
 * const isReady = await worker.waitForReady(5000);
 * if (!isReady) {
 *   console.warn('Worker initialization timed out');
 * }
 * ```
 */
export type WorkerClientWithTimeout = WorkerClient & {
  /**
   * Wait for the worker to become ready.
   *
   * @param timeoutMs - Maximum time to wait in milliseconds.
   *                    If undefined, uses implementation default (typically 30s).
   * @returns Promise that resolves to true if ready, false if timed out.
   */
  waitForReady(timeoutMs?: number): Promise<boolean>;
};

/**
 * Unified queue adapter interface.
 *
 * Provides standardized control semantics across durable (JobQueue) and
 * ephemeral (workerpool) queue implementations per ADR-0002.
 *
 * @see docs/adr/0002-queue-boundaries.md
 */
export type QueueAdapter = {
  /** Submit a single task for execution */
  add(task: TaskPayload, options?: QueueAddOptions): Promise<QueueResult>;
  /** Submit multiple tasks for execution */
  addBulk(
    tasks: readonly TaskPayload[],
    options?: QueueAddBulkOptions
  ): Promise<readonly QueueResult[]>;
  /** Subscribe to progress/error events */
  onProgress(listener: (event: QueueProgressEvent | QueueErrorEvent) => void): () => void;

  // --- Control semantics (ADR-0002 QueueControl) ---

  /**
   * Pause accepting new work.
   * Existing running tasks continue to completion.
   */
  pause(): void;
  /**
   * Resume accepting work after pause.
   */
  resume(): void;
  /**
   * Cancel all pending and running work.
   * Returns when all cancellations complete.
   */
  cancel(): Promise<void>;
  /**
   * Wait for all in-flight work to complete.
   * Does not accept new work during drain (use pause() first).
   */
  drain(): Promise<void>;
  /**
   * Whether the adapter is paused.
   */
  readonly isPaused: boolean;
  /**
   * Whether the adapter has active tasks processing.
   */
  readonly isProcessing: boolean;
};

export function toWorkerRequest(payload: TaskPayload): EmbedWorkerRequest {
  const baseRequest = {
    type: 'embed',
    id: payload.id,
    model: payload.model,
    texts: payload.texts,
  } satisfies Pick<EmbedWorkerRequest, 'type' | 'id' | 'model' | 'texts'>;

  const withOptionalFields: EmbedWorkerRequest = {
    ...baseRequest,
    ...(payload.truncateDim !== undefined ? { truncateDim: payload.truncateDim } : {}),
    ...(payload.dtype !== undefined ? { dtype: payload.dtype } : {}),
    deviceHint: payload.deviceHint,
    ...(payload.maxBatchSize !== undefined ? { maxBatchSize: payload.maxBatchSize } : {}),
    ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
    ...(payload.targetDimension !== undefined ? { targetDimension: payload.targetDimension } : {}),
    ...(payload.dimensionParameter !== undefined
      ? { dimensionParameter: payload.dimensionParameter }
      : {}),
  };
  return withOptionalFields;
}
