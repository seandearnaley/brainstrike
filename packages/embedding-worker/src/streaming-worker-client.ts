import { createWorkerRuntimeClient } from '@brainstrike/worker-runtime';
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

export interface StreamingEmbedOptions {
  readonly onBatch?: (event: EmbedWorkerBatch) => Promise<void> | void;
  readonly onDiagnostic?: (event: EmbedWorkerPipelineCacheDiagnostic) => void;
  readonly onError?: (event: EmbedWorkerError) => void;
  readonly onProgress?: (event: EmbedWorkerProgress) => void;
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

export class StreamingEmbeddingWorkerClient {
  private activeStream: {
    readonly cleanup: () => void;
    readonly reject: (error: Error) => void;
    readonly requestId: string;
  } | null = null;
  private readonly worker: Worker;
  private readonly runtime: ReturnType<typeof createWorkerRuntimeClient>;
  private readonly transport: ReturnType<typeof createWorkerRuntimeClient>['transport'];
  private executionChain: Promise<void> = Promise.resolve();

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
        this.worker.terminate();
      },
    });
    this.transport = this.runtime.transport;
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
      type: 'result',
      id: request.id,
      vectors,
      metadata,
    };
  }

  async stream(
    request: EmbedWorkerRequest,
    options: StreamingEmbedOptions = {}
  ): Promise<EmbedWorkerComplete['metadata']> {
    this.runtime.throwIfFailed();
    const run = async (): Promise<EmbedWorkerComplete['metadata']> =>
      await new Promise<EmbedWorkerComplete['metadata']>((resolve, reject) => {
        const cleanup = this.transport.onMessage((message) => {
          if (!isStreamEvent(message) || message.id !== request.id) {
            return;
          }

          this.handleStreamEvent(message, request, options, cleanup, resolve, reject);
        });
        this.activeStream = {
          requestId: request.id,
          cleanup,
          reject,
        };
        this.postMessage({
          type: 'stream-embed',
          request,
        });
      });

    const execution = this.executionChain.then(run, run);
    this.executionChain = execution.then(
      () => undefined,
      () => undefined
    );
    return await execution;
  }

  terminate(): void {
    const activeStream = this.activeStream;
    if (activeStream) {
      this.activeStream = null;
      activeStream.cleanup();
      activeStream.reject(new Error('Embedding worker terminated during an active stream.'));
    }
    this.runtime.clearFailure();
    this.runtime.dispose();
    this.worker.terminate();
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

    this.handleStreamBatch(payload, request, options, cleanup, reject);
  }

  private handleStreamBatch(
    payload: EmbedWorkerBatch,
    request: EmbedWorkerRequest,
    options: StreamingEmbedOptions,
    cleanup: StreamCleanup,
    reject: StreamReject
  ): void {
    void Promise.resolve(options.onBatch?.(payload))
      .then(() => {
        this.postMessage({
          type: 'stream-ack',
          id: request.id,
          batchIndex: payload.batchIndex,
        });
      })
      .catch((error: unknown) => {
        this.activeStream = null;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
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
