/**
 * BroadcastChannel name used to relay power-state messages (suspend/resume)
 * from the renderer to web workers. Shared to avoid magic string duplication.
 */
export const POWER_BROADCAST_CHANNEL = 'brainstrike-power';

export type {
  EmbeddingDevice,
  EmbeddingDeviceHint,
  EmbeddingDType,
  EmbedWorkerBatch,
  EmbedWorkerComplete,
  EmbedWorkerError,
  EmbedWorkerPipelineCacheDiagnostic,
  EmbedWorkerPipelineCacheEntryDiagnostic,
  EmbedWorkerPipelineCacheMemoryDiagnostic,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerStreamEvent,
  EmbedWorkerSuccess,
} from '@brainstrike/indexing-contract';

/**
 * Normalizes a vector to unit length (L2 norm).
 * @param vector - The input vector to normalize
 * @param destination - Optional output buffer. If equal to `vector`, normalizes in-place.
 * @returns The normalized vector (either new array or the destination buffer)
 */
export function l2Normalize(vector: Float32Array, destination?: Float32Array): Float32Array {
  let sum = 0;
  // biome-ignore lint/style/useForOf: Index-based loop needed for Float32Array performance
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    sum += value * value;
  }

  const magnitude = sum > 0 ? 1 / Math.sqrt(sum) : 1;
  const result = destination ?? new Float32Array(vector.length);
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
  // Preserve caller-sized small batches; memory ceilings belong in preferredMax
  // so desktop claim batches do not collapse into single-input GPU calls.
  const capped = preferredMax ?? 16;
  return Math.max(1, Math.min(capped, totalInputs));
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

/**
 * Clone an array-like of numbers into a Float32Array.
 *
 * For Float32Array inputs, uses the native TypedArray constructor for efficiency.
 * For other array types, uses a defensive loop to handle sparse arrays
 * (converts undefined → 0 instead of NaN from Number(undefined)).
 */
export function cloneAsFloat32(values: ArrayLike<number>): Float32Array {
  if (values instanceof Float32Array) {
    return new Float32Array(values);
  }
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
    const vec = cloneAsFloat32(output);
    return [truncateVector(l2Normalize(vec, vec), truncateDim)];
  }
  if (
    output instanceof Float64Array ||
    output instanceof Int32Array ||
    output instanceof Uint8Array
  ) {
    const vec = cloneAsFloat32(output);
    return [truncateVector(l2Normalize(vec, vec), truncateDim)];
  }
  if (Array.isArray(output)) {
    if (output.length === 0) {
      return [];
    }
    if (isNumberArray(output)) {
      const vector = cloneAsFloat32(output);
      return [truncateVector(l2Normalize(vector, vector), truncateDim)];
    }
    return output.flatMap((item) => vectorsFromPipelineOutput(item, truncateDim));
  }
  if (typeof output === 'number') {
    const vec = Float32Array.of(Number(output));
    return [truncateVector(l2Normalize(vec, vec), truncateDim)];
  }
  return [];
}
