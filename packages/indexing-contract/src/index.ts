export type EmbeddingDevice = 'webgpu' | 'wasm';

export type EmbeddingDeviceHint = EmbeddingDevice;

export type EmbeddingDType = 'fp16' | 'q4' | 'fp32';

export type EmbeddingDimensionParameter =
  | 'dimensions'
  | 'output_dimensionality'
  | 'output_dimension';

export interface EmbedWorkerRequest {
  readonly deviceHint: EmbeddingDeviceHint;
  readonly dimensionParameter?: EmbeddingDimensionParameter;
  readonly dtype?: EmbeddingDType;
  readonly id: string;
  readonly maxBatchSize?: number;
  readonly model: string;
  readonly provider?: string;
  readonly targetDimension?: number;
  readonly texts: readonly string[];
  readonly truncateDim?: number;
  readonly type: 'embed';
}

export interface EmbedWorkerProgress {
  readonly id: string;
  readonly phase: 'initializing' | 'embedding' | 'complete';
  readonly progress: number;
  readonly type: 'progress';
}

export interface EmbedWorkerBatch {
  readonly batchIndex: number;
  readonly endIndex: number;
  readonly id: string;
  readonly startIndex: number;
  readonly type: 'batch';
  readonly vectors: readonly Float32Array[];
}

export interface EmbedWorkerSuccess {
  readonly id: string;
  readonly metadata: {
    readonly model: string;
    readonly device: EmbeddingDevice;
    readonly dtype: EmbeddingDType;
    readonly batchSize: number;
    readonly elapsedMs: number;
    readonly fallbackApplied: boolean;
    readonly dimensions: number;
  };
  readonly type: 'result';
  readonly vectors: readonly Float32Array[];
}

export interface EmbedWorkerError {
  readonly cause?: string | undefined;
  readonly id: string;
  readonly message: string;
  readonly type: 'error';
}

export interface EmbedWorkerComplete {
  readonly id: string;
  readonly metadata: EmbedWorkerSuccess['metadata'];
  readonly type: 'complete';
}

export type EmbedWorkerStreamEvent =
  | EmbedWorkerBatch
  | EmbedWorkerComplete
  | EmbedWorkerError
  | EmbedWorkerProgress;
