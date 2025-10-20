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
  readonly deviceHint?: EmbeddingDeviceHint;
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

export interface QueueAdapter {
  add(task: TaskPayload, options?: QueueAddOptions): Promise<QueueResult>;
  addBulk(
    tasks: readonly TaskPayload[],
    options?: QueueAddBulkOptions
  ): Promise<readonly QueueResult[]>;
  onProgress(listener: (event: QueueProgressEvent | QueueErrorEvent) => void): () => void;
  pause(): void;
  resume(): void;
  drain(): Promise<void>;
}

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
    ...(payload.deviceHint !== undefined ? { deviceHint: payload.deviceHint } : {}),
    ...(payload.maxBatchSize !== undefined ? { maxBatchSize: payload.maxBatchSize } : {}),
    ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
    ...(payload.targetDimension !== undefined ? { targetDimension: payload.targetDimension } : {}),
    ...(payload.dimensionParameter !== undefined
      ? { dimensionParameter: payload.dimensionParameter }
      : {}),
  };
  return withOptionalFields;
}
