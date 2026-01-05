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
