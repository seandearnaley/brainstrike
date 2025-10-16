export type EmbeddingDevice = 'webgpu' | 'wasm';

export type EmbeddingDeviceHint = EmbeddingDevice | 'auto';

export type EmbeddingDType = 'fp16' | 'q4' | 'fp32';

export interface EmbedWorkerRequest {
  readonly type: 'embed';
  readonly id: string;
  readonly model: string;
  readonly texts: readonly string[];
  readonly truncateDim?: number;
  readonly dtype?: EmbeddingDType;
  readonly deviceHint?: EmbeddingDeviceHint;
  /**
   * Optional upper bound for batch sizing. Disclosed so the queue can tweak for stress tests.
   */
  readonly maxBatchSize?: number;
}

export interface EmbedWorkerProgress {
  readonly type: 'progress';
  readonly id: string;
  readonly progress: number;
  readonly phase: 'initializing' | 'embedding' | 'complete';
}

export interface EmbedWorkerSuccess {
  readonly type: 'result';
  readonly id: string;
  readonly vectors: readonly Float32Array[];
  readonly metadata: {
    readonly model: string;
    readonly device: EmbeddingDevice;
    readonly dtype: EmbeddingDType;
    readonly batchSize: number;
    readonly elapsedMs: number;
    readonly fallbackApplied: boolean;
    readonly dimensions: number;
  };
}

export interface EmbedWorkerError {
  readonly type: 'error';
  readonly id: string;
  readonly message: string;
  readonly cause?: unknown;
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    sum += value * value;
  }

  const magnitude = sum > 0 ? 1 / Math.sqrt(sum) : 1;
  const result = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    result[index] = value * magnitude;
  }
  return result;
}

export function truncateVector(vector: Float32Array, dimension?: number): Float32Array {
  if (dimension === undefined || dimension <= 0 || dimension >= vector.length) {
    return vector;
  }
  const result = new Float32Array(dimension);
  result.set(vector.subarray(0, dimension));
  return result;
}

export function computeInitialBatchSize(totalInputs: number, preferredMax?: number): number {
  if (totalInputs <= 1) {
    return 1;
  }
  const capped = preferredMax ?? 16;
  const heuristic = Math.ceil(totalInputs / 8);
  return Math.max(1, Math.min(capped, heuristic));
}

export function normalizeProgress(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function cloneAsFloat32(values: ArrayLike<number>): Float32Array {
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    result[index] = raw === undefined ? 0 : Number(raw);
  }
  return result;
}

function isNumberArray(input: readonly unknown[]): input is number[] {
  return input.every((item) => typeof item === 'number');
}

export function vectorsFromPipelineOutput(output: unknown, truncateDim?: number): Float32Array[] {
  if (output instanceof Float32Array) {
    return [truncateVector(l2Normalize(cloneAsFloat32(output)), truncateDim)];
  }
  if (
    output instanceof Float64Array ||
    output instanceof Int32Array ||
    output instanceof Uint8Array
  ) {
    return [truncateVector(l2Normalize(cloneAsFloat32(output)), truncateDim)];
  }
  if (Array.isArray(output)) {
    if (output.length === 0) {
      return [];
    }
    if (isNumberArray(output)) {
      const vector = cloneAsFloat32(output);
      return [truncateVector(l2Normalize(vector), truncateDim)];
    }
    return output.flatMap((item) => vectorsFromPipelineOutput(item, truncateDim));
  }
  if (typeof output === 'number') {
    return [truncateVector(l2Normalize(Float32Array.of(Number(output))), truncateDim)];
  }
  return [];
}
