import type {
  EmbedWorkerBatch,
  EmbedWorkerComplete,
  EmbedWorkerError,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerStreamEvent,
  EmbedWorkerSuccess,
} from './shared';
import { resolveEmbeddingWorkerUrl } from './worker-url';

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

export interface StreamingEmbedOptions {
  readonly onBatch?: (event: EmbedWorkerBatch) => Promise<void> | void;
  readonly onError?: (event: EmbedWorkerError) => void;
  readonly onProgress?: (event: EmbedWorkerProgress) => void;
}

function isStreamEvent(value: unknown): value is EmbedWorkerStreamEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { type?: unknown };
  return (
    candidate.type === 'batch' ||
    candidate.type === 'complete' ||
    candidate.type === 'error' ||
    candidate.type === 'progress'
  );
}

export class StreamingEmbeddingWorkerClient {
  private readonly worker: Worker;
  private executionChain: Promise<void> = Promise.resolve();

  constructor(worker?: Worker) {
    this.worker =
      worker ??
      new Worker(resolveEmbeddingWorkerUrl(), {
        type: 'module',
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
    const run = async (): Promise<EmbedWorkerComplete['metadata']> =>
      await new Promise<EmbedWorkerComplete['metadata']>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<unknown>) => {
          if (!isStreamEvent(event.data)) {
            return;
          }

          const payload = event.data;
          if (payload.id !== request.id) {
            return;
          }

          if (payload.type === 'progress') {
            options.onProgress?.(payload);
            return;
          }

          if (payload.type === 'error') {
            options.onError?.(payload);
            cleanup();
            reject(new Error(payload.message));
            return;
          }

          if (payload.type === 'complete') {
            cleanup();
            resolve(payload.metadata);
            return;
          }

          void Promise.resolve(options.onBatch?.(payload))
            .then(() => {
              this.postMessage({
                type: 'stream-ack',
                id: request.id,
                batchIndex: payload.batchIndex,
              });
            })
            .catch((error: unknown) => {
              cleanup();
              reject(error instanceof Error ? error : new Error(String(error)));
            });
        };

        const cleanup = () => {
          this.worker.removeEventListener('message', handleMessage);
        };

        this.worker.addEventListener('message', handleMessage);
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
    this.worker.terminate();
  }

  private postMessage(message: StreamWorkerMessage): void {
    this.worker.postMessage(message);
  }
}
