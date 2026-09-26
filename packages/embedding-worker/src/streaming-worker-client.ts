import {
  assertEmbedWorkerBatch,
  assertEmbedWorkerComplete,
  assertEmbedWorkerPipelineCacheDiagnostic,
} from '@brainstrike/indexing-contract';
import { createWorkerRuntimeClient } from '@brainstrike/worker-runtime';
import {
  recordEmbeddingBatchTelemetry,
  recordEmbeddingPipelineCacheTelemetry,
  removeEmbeddingTelemetrySource,
} from './embedding-telemetry';
import type {
  EmbedWorkerBatch,
  EmbedWorkerComplete,
  EmbedWorkerError,
  EmbedWorkerPipelineCacheDiagnostic,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerStreamEvent,
  EmbedWorkerSuccess,
} from './shared';
import { computeInitialBatchSize } from './shared';

let nextTelemetrySourceId = 1;

interface StartStreamMessage {
  readonly request: EmbedWorkerRequest;
  readonly type: 'stream-embed';
}

interface AckBatchMessage {
  readonly batchIndex: number;
  readonly id: string;
  readonly type: 'stream-ack';
}

type StreamWorkerMessage = AckBatchMessage | StartStreamMessage;
type StreamCleanup = () => void;
type StreamResolve = (metadata: EmbedWorkerComplete['metadata']) => void;
type StreamReject = (error: Error) => void;

interface StreamBatchSequence {
  expectedBatchIndex: number;
  expectedStartIndex: number;
  expectedVectorDimensions: number | null;
  maximumObservedBatchSize: number;
}

export interface StreamingEmbedOptions {
  readonly onBatch?: (event: EmbedWorkerBatch) => Promise<void> | void;
  readonly onDiagnostic?: (event: EmbedWorkerPipelineCacheDiagnostic) => void;
  readonly onError?: (event: EmbedWorkerError) => void;
  readonly onProgress?: (event: EmbedWorkerProgress) => void;
  /** Terminating this dedicated worker cancels its active and queued streams. */
  readonly signal?: AbortSignal;
}

export interface StreamingEmbeddingWorkerClientOptions {
  readonly worker?: Worker;
  readonly workerUrl?: string;
}

function isStreamEvent(value: unknown): value is EmbedWorkerStreamEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { type?: unknown };
  return (
    candidate.type === 'batch' ||
    candidate.type === 'complete' ||
    candidate.type === 'diagnostic' ||
    candidate.type === 'error' ||
    candidate.type === 'progress'
  );
}

function isIdLessPipelineCacheCandidate(value: unknown): boolean {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate['id'] === undefined &&
    (candidate['type'] === 'diagnostic' || candidate['diagnostic'] === 'pipeline-cache')
  );
}

function assertStreamBatchSequence(
  batch: EmbedWorkerBatch,
  expectedBatchIndex: number,
  expectedStartIndex: number,
  requestTextCount: number
): void {
  if (batch.batchIndex !== expectedBatchIndex) {
    throw new Error(
      `Embedding worker batch.batchIndex ${batch.batchIndex} does not match expected batchIndex ${expectedBatchIndex}.`
    );
  }
  if (batch.startIndex !== expectedStartIndex) {
    throw new Error(
      `Embedding worker batch.startIndex ${batch.startIndex} does not match expected startIndex ${expectedStartIndex}.`
    );
  }
  if (batch.endIndex > requestTextCount) {
    throw new Error(
      `Embedding worker batch.endIndex ${batch.endIndex} exceeds request text count ${requestTextCount}.`
    );
  }
}

function validateStreamBatch(
  value: unknown,
  sequence: StreamBatchSequence,
  requestTextCount: number,
  onFailure: (error: unknown) => void
): value is EmbedWorkerBatch {
  try {
    assertEmbedWorkerBatch(value);
    assertStreamBatchSequence(
      value,
      sequence.expectedBatchIndex,
      sequence.expectedStartIndex,
      requestTextCount
    );
    const vectorDimensions = value.vectors[0]?.length;
    if (vectorDimensions === undefined) {
      throw new Error('Embedding worker batch must contain at least one vector.');
    }
    if (sequence.expectedVectorDimensions === null) {
      sequence.expectedVectorDimensions = vectorDimensions;
    } else if (vectorDimensions !== sequence.expectedVectorDimensions) {
      throw new Error(
        `Embedding worker batch vector dimensions changed from ${sequence.expectedVectorDimensions} to ${vectorDimensions}.`
      );
    }
    sequence.expectedBatchIndex += 1;
    sequence.expectedStartIndex = value.endIndex;
    sequence.maximumObservedBatchSize = Math.max(
      sequence.maximumObservedBatchSize,
      value.endIndex - value.startIndex
    );
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
}

function validateStreamCompletionCoverage(
  event: EmbedWorkerStreamEvent,
  embeddedTextCount: number,
  requestTextCount: number,
  onFailure: (error: Error) => void
): boolean {
  if (event.type !== 'complete' || embeddedTextCount === requestTextCount) {
    return true;
  }
  onFailure(
    new Error(
      `Embedding worker completed after ${embeddedTextCount} of ${requestTextCount} requested texts.`
    )
  );
  return false;
}

function assertStreamCompletionMatchesRequest(
  complete: EmbedWorkerComplete,
  request: EmbedWorkerRequest,
  sequence: StreamBatchSequence
): void {
  if (complete.metadata.model !== request.model) {
    throw new Error('Embedding worker complete.metadata.model does not match the request model.');
  }
  const expectedDtype = request.dtype ?? 'fp16';
  if (complete.metadata.dtype !== expectedDtype) {
    throw new Error('Embedding worker complete.metadata.dtype does not match the request dtype.');
  }
  const coherentFallback =
    request.deviceHint === 'webgpu' &&
    complete.metadata.device === 'wasm' &&
    complete.metadata.fallbackApplied;
  const coherentDirectDevice =
    complete.metadata.device === request.deviceHint && !complete.metadata.fallbackApplied;
  if (!(coherentFallback || coherentDirectDevice)) {
    throw new Error(
      'Embedding worker complete.metadata.device and metadata.fallbackApplied do not match the request device.'
    );
  }
  const expectedBatchSize = computeInitialBatchSize(request.texts.length, request.maxBatchSize);
  if (complete.metadata.batchSize !== expectedBatchSize) {
    throw new Error(
      'Embedding worker complete.metadata.batchSize does not match the request batch size.'
    );
  }
  if (
    request.texts.length > 0 &&
    sequence.maximumObservedBatchSize !== complete.metadata.batchSize
  ) {
    throw new Error(
      'Embedding worker complete.metadata.batchSize does not match the observed stream batches.'
    );
  }
  if (
    sequence.expectedVectorDimensions !== null &&
    complete.metadata.dimensions !== sequence.expectedVectorDimensions
  ) {
    throw new Error(
      `Embedding worker complete.metadata.dimensions ${complete.metadata.dimensions} does not match streamed vector dimensions ${sequence.expectedVectorDimensions}.`
    );
  }
}

function validateStreamMessage(
  value: unknown,
  request: EmbedWorkerRequest,
  sequence: StreamBatchSequence,
  onFailure: (error: unknown) => void
): value is EmbedWorkerStreamEvent {
  if (!isStreamEvent(value)) {
    return false;
  }
  // Stream payloads are request-scoped unless they are diagnostics. Cache/device
  // diagnostics describe worker-global state and may intentionally omit an id.
  if (value.id !== undefined && value.id !== request.id) {
    return false;
  }
  // Guard the id-less path explicitly so malformed progress/batch/complete
  // messages cannot be delivered to the active stream by accident.
  if (value.id === undefined && value.type !== 'diagnostic') {
    return false;
  }
  if (
    value.type === 'batch' &&
    !validateStreamBatch(value, sequence, request.texts.length, onFailure)
  ) {
    return false;
  }
  if (
    !validateStreamCompletionCoverage(
      value,
      sequence.expectedStartIndex,
      request.texts.length,
      onFailure
    )
  ) {
    return false;
  }
  if (value.type === 'complete') {
    try {
      assertEmbedWorkerComplete(value);
      assertStreamCompletionMatchesRequest(value, request, sequence);
    } catch (error) {
      onFailure(error);
      return false;
    }
  }
  return true;
}

export class StreamingEmbeddingWorkerClient {
  private activeStream: {
    readonly cleanup: () => void;
    readonly reject: (reason: unknown) => void;
    readonly requestId: string;
  } | null = null;
  private readonly worker: Worker;
  private readonly runtime: ReturnType<typeof createWorkerRuntimeClient>;
  private readonly transport: ReturnType<typeof createWorkerRuntimeClient>['transport'];
  private executionChain: Promise<void> = Promise.resolve();
  private telemetryCleanup: (() => void) | null = null;
  private terminated = false;
  private terminationReason: unknown;
  private readonly telemetrySourceId = `streaming-embedding-worker-${nextTelemetrySourceId++}`;

  /**
   * The worker must be supplied explicitly by the owning runtime so URL resolution stays
   * platform-specific and deterministic. This client no longer auto-resolves a worker URL.
   */
  constructor(workerOrOptions?: StreamingEmbeddingWorkerClientOptions | Worker) {
    const options = isWorkerLike(workerOrOptions) ? { worker: workerOrOptions } : workerOrOptions;
    if (options?.worker) {
      this.worker = options.worker;
    } else if (options?.workerUrl) {
      this.worker = new Worker(options.workerUrl, {
        type: 'module',
      });
    } else {
      throw new Error('StreamingEmbeddingWorkerClient requires an explicit worker or workerUrl.');
    }
    this.runtime = createWorkerRuntimeClient(this.worker, {
      createErrorFromEvent: (event) =>
        new Error(
          event.message
            ? `Embedding worker runtime error: ${event.message}`
            : 'Embedding worker runtime error (missing ErrorEvent.message)'
        ),
      onFailure: (error) => {
        const activeStream = this.activeStream;
        if (activeStream) {
          this.activeStream = null;
          activeStream.cleanup();
          activeStream.reject(error);
        }
        this.cleanupTelemetryListener();
        this.worker.terminate();
        removeEmbeddingTelemetrySource(this.telemetrySourceId);
      },
    });
    this.transport = this.runtime.transport;
    this.telemetryCleanup = this.transport.onMessage((message) => {
      if (!isIdLessPipelineCacheCandidate(message)) {
        return;
      }
      try {
        assertEmbedWorkerPipelineCacheDiagnostic(message);
        recordEmbeddingPipelineCacheTelemetry(this.telemetrySourceId, message);
      } catch (error) {
        this.runtime.markFailed(error);
        return;
      }
    });
  }

  async embed(
    request: EmbedWorkerRequest,
    options: StreamingEmbedOptions = {}
  ): Promise<EmbedWorkerSuccess> {
    const vectors: Float32Array[] = [];
    const metadata = await this.stream(request, {
      ...options,
      onBatch: async (event) => {
        for (const vector of event.vectors) {
          vectors.push(vector);
        }
        await options.onBatch?.(event);
      },
    });

    return {
      id: request.id,
      metadata,
      type: 'result',
      vectors,
    };
  }

  async stream(
    request: EmbedWorkerRequest,
    options: StreamingEmbedOptions = {}
  ): Promise<EmbedWorkerComplete['metadata']> {
    if (this.terminated) {
      throw this.terminationReason ?? new Error('Embedding worker was terminated.');
    }
    this.runtime.throwIfFailed();
    const signal = options.signal;
    // A queued request can abort while an earlier stream still owns executionChain.
    // This dedicated worker must terminate immediately so both promises settle.
    const onAbort = (): void => this.terminate(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    const run = async (): Promise<EmbedWorkerComplete['metadata']> => {
      if (this.terminated) {
        throw this.terminationReason ?? new Error('Embedding worker was terminated.');
      }
      signal?.throwIfAborted();
      // A prior stream can fail while this request is waiting on executionChain. Recheck at
      // execution time so a queued request never posts to the worker after onFailure terminates it.
      this.runtime.throwIfFailed();
      return await new Promise<EmbedWorkerComplete['metadata']>((resolve, reject) => {
        const batchSequence = {
          expectedBatchIndex: 0,
          expectedStartIndex: 0,
          expectedVectorDimensions: null,
          maximumObservedBatchSize: 0,
        };
        const cleanupMessage = this.transport.onMessage((message) => {
          if (
            !validateStreamMessage(message, request, batchSequence, (error) =>
              this.runtime.markFailed(error)
            )
          ) {
            return;
          }

          this.handleStreamEvent(message, request, options, cleanup, resolve, reject);
        });
        const cleanup = (): void => {
          cleanupMessage();
          signal?.removeEventListener('abort', onAbort);
        };
        this.activeStream = {
          cleanup,
          reject,
          requestId: request.id,
        };
        this.postMessage({
          request,
          type: 'stream-embed',
        });
      });
    };

    const execution = this.executionChain.then(run, run);
    this.executionChain = execution.then(
      () => undefined,
      () => undefined
    );
    try {
      return await execution;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  terminate(reason?: unknown): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.terminationReason = reason;
    const activeStream = this.activeStream;
    if (activeStream) {
      this.activeStream = null;
      activeStream.cleanup();
      activeStream.reject(
        reason ?? new Error('Embedding worker terminated during an active stream.')
      );
    }
    this.runtime.clearFailure();
    this.cleanupTelemetryListener();
    this.runtime.dispose();
    this.worker.terminate();
    removeEmbeddingTelemetrySource(this.telemetrySourceId);
  }

  private postMessage(message: StreamWorkerMessage): void {
    this.transport.postMessage(message);
  }

  private handleStreamEvent(
    payload: EmbedWorkerStreamEvent,
    request: EmbedWorkerRequest,
    options: StreamingEmbedOptions,
    cleanup: StreamCleanup,
    resolve: StreamResolve,
    reject: StreamReject
  ): void {
    if (payload.type === 'progress') {
      options.onProgress?.(payload);
      return;
    }

    if (payload.type === 'diagnostic') {
      try {
        assertEmbedWorkerPipelineCacheDiagnostic(payload);
        if (payload.id !== undefined) {
          recordEmbeddingPipelineCacheTelemetry(this.telemetrySourceId, payload);
        }
      } catch (error) {
        this.runtime.markFailed(error);
        return;
      }
      options.onDiagnostic?.(payload);
      return;
    }

    if (payload.type === 'error') {
      options.onError?.(payload);
      const failure = this.runtime.markFailed(new Error(payload.message));
      this.activeStream = null;
      cleanup();
      reject(failure);
      return;
    }

    if (payload.type === 'complete') {
      this.activeStream = null;
      cleanup();
      resolve(payload.metadata);
      return;
    }

    this.handleStreamBatch(payload, request, options);
  }

  private cleanupTelemetryListener(): void {
    const cleanup = this.telemetryCleanup;
    if (cleanup === null) {
      return;
    }
    this.telemetryCleanup = null;
    cleanup();
  }

  private handleStreamBatch(
    payload: EmbedWorkerBatch,
    request: EmbedWorkerRequest,
    options: StreamingEmbedOptions
  ): void {
    recordEmbeddingBatchTelemetry(this.telemetrySourceId, payload);
    void Promise.resolve()
      .then(() => options.onBatch?.(payload))
      .then(() => {
        this.postMessage({
          batchIndex: payload.batchIndex,
          id: request.id,
          type: 'stream-ack',
        });
      })
      .catch((error: unknown) => {
        this.runtime.markFailed(error instanceof Error ? error : new Error(String(error)));
      });
  }
}

function isWorkerLike(value: unknown): value is Worker {
  return (
    typeof value === 'object' &&
    value !== null &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'postMessage' in value &&
    typeof value.postMessage === 'function' &&
    'terminate' in value &&
    typeof value.terminate === 'function'
  );
}
