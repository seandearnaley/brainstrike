/// <reference lib="webworker" />

import { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { env, type FeatureExtractionPipeline, pipeline, Tensor } from '@huggingface/transformers';
import { Transfer, worker, workerEmit } from 'workerpool';
import type {
  EmbeddingDevice,
  EmbeddingDeviceHint,
  EmbeddingDType,
  EmbedWorkerError,
  EmbedWorkerRequest,
  EmbedWorkerSuccess,
} from './shared';
import {
  computeInitialBatchSize,
  l2Normalize,
  normalizeProgress,
  truncateVector,
  vectorsFromPipelineOutput,
} from './shared';

type FeatureExtractor = FeatureExtractionPipeline &
  ((
    inputs: string | readonly string[],
    options?: {
      readonly pooling?: 'mean' | 'max' | 'cls';
      readonly normalize?: boolean;
    }
  ) => Promise<unknown>);

const pipelines = new Map<string, Promise<FeatureExtractor>>();

// Allow remote model downloads when a cache directory is not specified. This aligns with the
// Transformers.js recommendation for browser deployments. Source: https://huggingface.co/docs/transformers.js/en/integrations/web
env.allowRemoteModels = env.allowRemoteModels ?? true;

function hasWebGPU(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined'
  );
}

function inferDevice(hint: EmbeddingDeviceHint = 'auto'): EmbeddingDevice {
  if (hint === 'auto') {
    return hasWebGPU() ? 'webgpu' : 'wasm';
  }
  return hint === 'webgpu' && hasWebGPU() ? 'webgpu' : 'wasm';
}

async function loadPipeline(
  model: string,
  device: EmbeddingDevice,
  dtype: EmbeddingDType
): Promise<FeatureExtractor> {
  const cacheKey = `${model}|${device}|${dtype}`;
  const existing = pipelines.get(cacheKey);
  if (existing !== undefined) {
    return existing;
  }

  const loader = (async () => {
    try {
      const result = await pipeline('feature-extraction', model, { device, dtype });
      return result as FeatureExtractor;
    } catch (error) {
      if (device === 'webgpu') {
        const fallback = await pipeline('feature-extraction', model, { device: 'wasm', dtype });
        return fallback as FeatureExtractor;
      }
      throw error;
    }
  })();

  pipelines.set(cacheKey, loader);
  return loader;
}

function assertValidDimension(payload: EmbedWorkerRequest, requestedDimension: number): void {
  if (!Number.isFinite(requestedDimension) || requestedDimension <= 0) {
    const providerLabel = payload.provider ? `Provider "${payload.provider}"` : 'Embedding request';
    const parameterHint =
      payload.dimensionParameter === 'dimensions'
        ? 'Set a positive integer via the dimensions parameter.'
        : payload.dimensionParameter === 'output_dimensionality'
          ? 'Set a positive integer via the output_dimensionality parameter.'
          : payload.dimensionParameter === 'output_dimension'
            ? 'Set a positive integer via the output_dimension parameter.'
            : 'Provide a positive integer targetDimension.';
    throw new Error(
      `${providerLabel} supplied an invalid target dimension (${requestedDimension}). ${parameterHint}`
    );
  }

  if (!Number.isInteger(requestedDimension)) {
    throw new Error(
      `targetDimension must be an integer, received ${requestedDimension} for model ${payload.model}.`
    );
  }

  if (requestedDimension > MAX_EMBEDDING_DIMENSION) {
    throw new Error(
      `targetDimension ${requestedDimension} exceeds pgvector's supported maximum of ${MAX_EMBEDDING_DIMENSION} dimensions.`
    );
  }
}

function cloneAsFloat32(values: ArrayLike<number>): Float32Array {
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    result[index] = Number(values[index]);
  }
  return result;
}

function convertTensorToVectors(tensor: Tensor, truncateDim?: number): Float32Array[] {
  const dims = tensor.dims;
  const data = tensor.data as ArrayLike<number>;
  if (dims.length === 1) {
    return [truncateVector(l2Normalize(cloneAsFloat32(data)), truncateDim)];
  }
  if (dims.length === 2) {
    const [batch, width] = dims as [number, number];
    const typed = cloneAsFloat32(data);
    const vectors: Float32Array[] = [];
    for (let row = 0; row < batch; row += 1) {
      const start = row * width;
      const slice = typed.subarray(start, start + width);
      const normalized = l2Normalize(new Float32Array(slice));
      vectors.push(truncateVector(normalized, truncateDim));
    }
    return vectors;
  }
  const flattened = Float32Array.from(tensor.tolist().flat(Number.POSITIVE_INFINITY) as number[]);
  return [truncateVector(l2Normalize(flattened), truncateDim)];
}

type EmbeddingContext = {
  readonly id: string;
  readonly model: string;
  readonly texts: readonly string[];
  readonly truncateDim?: number;
  readonly dtype: EmbeddingDType;
  readonly started: number;
  readonly total: number;
  readonly provider?: string;
  readonly targetDimension?: number;
  readonly dimensionParameter?: 'dimensions' | 'output_dimensionality' | 'output_dimension';
};

type EmbeddingState = {
  device: EmbeddingDevice;
  batchSize: number;
  fallbackApplied: boolean;
  readonly maxBatchSize?: number;
};

function createContext(payload: EmbedWorkerRequest): EmbeddingContext {
  const requestedDimension = payload.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  const context: EmbeddingContext = {
    id: payload.id,
    model: payload.model,
    texts: payload.texts,
    dtype: payload.dtype ?? 'fp16',
    started: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    total: payload.texts.length,
    targetDimension: requestedDimension,
  };
  if (payload.truncateDim !== undefined) {
    (context as { truncateDim?: number }).truncateDim = payload.truncateDim;
  } else if (Number.isFinite(requestedDimension)) {
    (context as { truncateDim?: number }).truncateDim = requestedDimension;
  }
  if (payload.provider) {
    (context as { provider?: string }).provider = payload.provider;
  }
  if (payload.dimensionParameter) {
    (
      context as {
        dimensionParameter?: 'dimensions' | 'output_dimensionality' | 'output_dimension';
      }
    ).dimensionParameter = payload.dimensionParameter;
  }
  return context;
}

function createInitialState(
  context: EmbeddingContext,
  deviceHint: EmbeddingDeviceHint,
  maxBatchSize: number | undefined
): EmbeddingState {
  return {
    device: inferDevice(deviceHint),
    batchSize: computeInitialBatchSize(context.total, maxBatchSize),
    fallbackApplied: false,
    ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
  };
}

async function embed(payload: EmbedWorkerRequest): Promise<EmbedWorkerSuccess> {
  const context = createContext(payload);
  const { id, model, texts } = context;
  const deviceHint = payload.deviceHint ?? 'auto';
  const requestedDimension = context.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  assertValidDimension(payload, requestedDimension);

  if (texts.length === 0) {
    return {
      type: 'result',
      id,
      vectors: [],
      metadata: {
        model,
        device: inferDevice(deviceHint),
        dtype: context.dtype,
        batchSize: 0,
        elapsedMs: 0,
        fallbackApplied: false,
        dimensions: context.truncateDim ?? 0,
      },
    };
  }

  workerEmit({
    type: 'progress',
    id,
    progress: 0,
    phase: 'initializing',
  });

  const state = createInitialState(context, deviceHint, payload.maxBatchSize);
  try {
    const result = await processWithFallbacks(context, state);
    return result;
  } catch (error) {
    emitErrorEvent(context.id, error);
    throw error;
  }
}

async function processWithFallbacks(
  context: EmbeddingContext,
  state: EmbeddingState
): Promise<EmbedWorkerSuccess> {
  for (;;) {
    try {
      const extractor = await loadPipeline(context.model, state.device, context.dtype);
      const vectors = await runBatches(context, state, extractor);
      const success = buildSuccessResult(context, state, vectors);
      if (vectors.length === 0) {
        return success;
      }
      const transferList = vectors.map((vector) => vector.buffer);
      return new Transfer(success, transferList) as unknown as EmbedWorkerSuccess;
    } catch (error) {
      if (!adjustStateOnError(state, context)) {
        throw error;
      }
    }
  }
}

async function runBatches(
  context: EmbeddingContext,
  state: EmbeddingState,
  extractor: FeatureExtractor
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  const { texts, truncateDim, id, total } = context;

  for (let startIndex = 0; startIndex < total; startIndex += state.batchSize) {
    const endIndex = Math.min(total, startIndex + state.batchSize);
    const slice = texts.slice(startIndex, endIndex);
    const rawOutput = await extractor(slice, { pooling: 'mean', normalize: false });
    const vectorsFromBatch =
      rawOutput instanceof Tensor
        ? convertTensorToVectors(rawOutput, truncateDim)
        : vectorsFromPipelineOutput(rawOutput, truncateDim);
    if (vectorsFromBatch.length === 0) {
      throw new Error('Embedding pipeline returned no tensors');
    }
    for (const vector of vectorsFromBatch) {
      vectors.push(vector);
    }

    workerEmit({
      type: 'progress',
      id,
      phase: 'embedding',
      progress: normalizeProgress(endIndex / total),
    });
  }

  return vectors;
}

function buildSuccessResult(
  context: EmbeddingContext,
  state: EmbeddingState,
  vectors: Float32Array[]
): EmbedWorkerSuccess {
  const finished = typeof performance !== 'undefined' ? performance.now() : Date.now();
  workerEmit({
    type: 'progress',
    id: context.id,
    phase: 'complete',
    progress: 1,
  });

  return {
    type: 'result',
    id: context.id,
    vectors,
    metadata: {
      model: context.model,
      device: state.device,
      dtype: context.dtype,
      batchSize: state.batchSize,
      elapsedMs: finished - context.started,
      fallbackApplied: state.fallbackApplied,
      dimensions: vectors[0]?.length ?? context.truncateDim ?? 0,
    },
  };
}

function adjustStateOnError(state: EmbeddingState, context: EmbeddingContext): boolean {
  if (state.batchSize > 1) {
    state.batchSize = Math.max(1, Math.floor(state.batchSize / 2));
    return true;
  }

  if (state.device === 'webgpu') {
    state.device = 'wasm';
    state.fallbackApplied = true;
    state.batchSize = computeInitialBatchSize(context.total, state.maxBatchSize);
    return true;
  }

  return false;
}

function serializeErrorCause(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (error instanceof Error) {
    // Include stack trace if available for debugging
    return error.stack ?? error.message;
  }
  // Handle raw numeric error codes (e.g., from ONNX runtime)
  if (typeof error === 'number') {
    return `Error code: ${error} (0x${error.toString(16)})`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function emitErrorEvent(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const event: EmbedWorkerError = {
    type: 'error',
    id,
    message,
    cause: serializeErrorCause(error),
  };
  workerEmit(event);
}

worker({
  // Workerpool exposes the `workerEmit` helper for streaming progress back to the main thread.
  // Source: https://github.com/josdejong/workerpool#progress
  runEmbedding: embed,
});
