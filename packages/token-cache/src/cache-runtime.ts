export { __resetHasherForTests, FileHasher, fileHasher } from './file-hasher';
export {
  resolveBackgroundIndexerWorkerUrl,
  resolveTokenCacheWorkerUrl,
} from './resolve-worker-url';
export { TokenCacheStore } from './token-cache-store';
export type {
  FileMetadata,
  TokenCacheEntry,
  TokenCountError,
  TokenCountingMode,
  TokenCountProgress,
  TokenCountRequest,
  TokenCountResult,
  TokenWorkerMessage,
  TokenWorkerMethod,
  TokenWorkerRequest,
  TokenWorkerResponse,
  TokenWorkerResponseError,
} from './types';
export type {
  TokenCacheRuntimeStore,
  UseTokenCacheOptions,
  UseTokenCacheReturn,
} from './use-token-cache';
export { useTokenCache } from './use-token-cache';

const UNSUPPORTED_OPTION_KEYS = ['forkArgs', 'forkOpts', 'maxQueueSize', 'onCreateWorker'] as const;

export interface WorkerPoolOptions {
  forkArgs?: string[];
  forkOpts?: object;
  maxQueueSize?: number;
  maxWorkers?: number;
  minWorkers?: number | 'max';
  onCreateWorker?: () => { on: unknown; forkArgs?: string[] };
  onTerminateWorker?: () => void;
  workerOpts?: {
    type?: 'classic' | 'module';
  };
  workerTerminateTimeout?: number;
  workerType?: 'auto' | 'web' | 'process' | 'thread';
}

export interface WorkerPoolInterface {
  exec: (method: string, params: unknown[]) => Promise<unknown>;
  stats: () => {
    activeTasks: number;
    busyWorkers: number;
    idleWorkers: number;
    pendingTasks: number;
    totalWorkers: number;
  };
  terminate: (force?: boolean, timeout?: number) => Promise<void>;
}

interface TokenWorkerRequestEnvelope {
  method: 'countTokens' | 'countTokensBatch' | 'hashContent' | 'hashContentBatch';
  params: unknown[];
  requestId: string;
  type: 'request';
}

interface TokenWorkerResponseEnvelope {
  requestId: string;
  result: unknown;
  type: 'response';
}

interface TokenWorkerErrorEnvelope {
  cause?: string;
  message: string;
  requestId: string;
  type: 'error';
}

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
}

let nextRequestId = 0;

function createRequestId(): string {
  nextRequestId += 1;
  return `token-worker-request:${nextRequestId}`;
}

function isTokenWorkerResponseEnvelope(value: unknown): value is TokenWorkerResponseEnvelope {
  if (!(typeof value === 'object' && value !== null)) {
    return false;
  }

  const candidate = value as Partial<TokenWorkerResponseEnvelope>;
  return (
    candidate.type === 'response' &&
    typeof candidate.requestId === 'string' &&
    'result' in candidate
  );
}

function isTokenWorkerErrorEnvelope(value: unknown): value is TokenWorkerErrorEnvelope {
  if (!(typeof value === 'object' && value !== null)) {
    return false;
  }

  const candidate = value as Partial<TokenWorkerErrorEnvelope>;
  return (
    candidate.type === 'error' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.message === 'string'
  );
}

function assertSupportedWorkerPoolOptions(options: WorkerPoolOptions | undefined): void {
  if (!options) {
    return;
  }

  for (const key of UNSUPPORTED_OPTION_KEYS) {
    if (options[key] !== undefined) {
      throw new Error(`Unsupported token cache worker option: ${key}`);
    }
  }

  if (options.workerType && options.workerType !== 'auto' && options.workerType !== 'web') {
    throw new Error(
      `Unsupported token cache workerType "${options.workerType}". Token cache workers must run as browser Web Workers.`
    );
  }

  if (options.minWorkers !== undefined && options.minWorkers !== 1) {
    throw new Error(
      `Unsupported token cache minWorkers value "${String(options.minWorkers)}". Token cache uses exactly one dedicated worker.`
    );
  }

  if (options.maxWorkers !== undefined && options.maxWorkers !== 1) {
    throw new Error(
      `Unsupported token cache maxWorkers value "${String(options.maxWorkers)}". Token cache uses exactly one dedicated worker.`
    );
  }
}

class DirectTokenCacheWorkerPool implements WorkerPoolInterface {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private terminated = false;
  private terminalError: Error | null = null;
  private readonly worker: Worker;

  constructor(workerUrl: string, workerOptions: WorkerPoolOptions | undefined) {
    const workerType = workerOptions?.workerOpts?.type ?? 'module';
    this.worker = new Worker(workerUrl, {
      type: workerType,
      name: 'brainstrike-token-cache',
    });
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleError);
    this.worker.addEventListener('messageerror', this.handleMessageError);
  }

  exec(method: string, params: unknown[]): Promise<unknown> {
    if (this.terminated) {
      throw new Error('Token cache worker pool has been terminated');
    }
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (!isSupportedMethod(method)) {
      throw new Error(`Unsupported token cache worker method: ${method}`);
    }

    const requestId = createRequestId();
    const request: TokenWorkerRequestEnvelope = {
      type: 'request',
      requestId,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error(`Failed to post token cache worker request: ${String(error)}`)
        );
      }
    });
  }

  stats() {
    const activeTasks = this.pendingRequests.size;
    return {
      totalWorkers: this.terminated ? 0 : 1,
      busyWorkers: activeTasks > 0 ? 1 : 0,
      idleWorkers: this.terminated ? 0 : activeTasks > 0 ? 0 : 1,
      pendingTasks: activeTasks,
      activeTasks,
    };
  }

  async terminate(): Promise<void> {
    if (this.terminated) {
      return;
    }

    this.terminated = true;
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    this.worker.terminate();
    this.rejectPendingRequests(
      new Error('Token cache worker pool terminated before requests completed')
    );
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (isTokenWorkerResponseEnvelope(event.data)) {
      const pending = this.pendingRequests.get(event.data.requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(event.data.requestId);
      pending.resolve(event.data.result);
      return;
    }

    if (isTokenWorkerErrorEnvelope(event.data)) {
      const pending = this.pendingRequests.get(event.data.requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(event.data.requestId);
      pending.reject(buildWorkerError(event.data.message, event.data.cause));
    }
  };

  private readonly handleError = (event: ErrorEvent): void => {
    const error = buildWorkerError(
      event.message || 'Token cache worker raised an error event',
      event.error instanceof Error ? event.error.stack : undefined
    );
    this.terminalError = error;
    this.rejectPendingRequests(error);
  };

  private readonly handleMessageError = (): void => {
    const error = new Error('Token cache worker failed to deserialize a message');
    this.terminalError = error;
    this.rejectPendingRequests(error);
  };

  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(requestId);
      pending.reject(error);
    }
  }
}

function buildWorkerError(message: string, cause?: string): Error {
  return new Error(cause && cause !== message ? `${message}\nWorker cause: ${cause}` : message);
}

function isSupportedMethod(method: string): method is TokenWorkerRequestEnvelope['method'] {
  return (
    method === 'countTokens' ||
    method === 'countTokensBatch' ||
    method === 'hashContent' ||
    method === 'hashContentBatch'
  );
}

export async function createTokenCacheWorkerPool(
  workerUrl: string,
  options?: WorkerPoolOptions
): Promise<WorkerPoolInterface> {
  assertSupportedWorkerPoolOptions(options);
  return new DirectTokenCacheWorkerPool(workerUrl, options);
}
