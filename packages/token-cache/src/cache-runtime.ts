export { __resetHasherForTests, FileHasher, fileHasher } from './file-hasher';
export {
  resolveBackgroundIndexerWorkerUrl,
  resolveTokenCacheWorkerUrl,
} from './resolve-worker-url';
export { TokenCacheStore } from './token-cache-store';
export type {
  FileMetadata,
  TokenCacheEntry,
  TokenCacheStats,
  TokenCacheStoreOptions,
  TokenCountError,
  TokenCountingMode,
  TokenCountProgress,
  TokenCountRequest,
  TokenCountResult,
  TokenWorkerMessage,
} from './types';
export type { UseTokenCacheOptions, UseTokenCacheReturn } from './use-token-cache';
export { useTokenCache } from './use-token-cache';

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
    totalWorkers: number;
    busyWorkers: number;
    idleWorkers: number;
    pendingTasks: number;
    activeTasks: number;
  };
  terminate: (force?: boolean, timeout?: number) => Promise<void>;
}

let workerpoolModule: typeof import('workerpool') | null = null;

async function getWorkerpool(): Promise<typeof import('workerpool')> {
  if (!workerpoolModule) {
    workerpoolModule = await import('workerpool');
  }
  return workerpoolModule;
}

export async function createTokenCacheWorkerPool(
  workerUrl: string,
  options?: WorkerPoolOptions
): Promise<WorkerPoolInterface> {
  const workerpool = await getWorkerpool();

  const workerOpts: { type?: 'classic' | 'module' } = {
    type: 'module',
    ...(options?.workerOpts ?? {}),
  };
  const workerType = options?.workerType ?? 'web';

  return workerpool.pool(workerUrl, {
    minWorkers: 1,
    maxWorkers: 2,
    ...options,
    workerType,
    workerOpts,
  }) as unknown as WorkerPoolInterface;
}
