import type { WorkerpoolAdapterOptions } from './browser-workerpool-options';
import type { QueueAdapter } from './types';
import { supportsWorkers } from './util';

export type { WorkerpoolAdapterOptions } from './browser-workerpool-options';

export interface CreateBrowserEmbeddingQueueOptions {
  /**
   * When true, require a workerpool adapter and throw if unavailable.
   * @deprecated Always true - workers are required. Kept for API compatibility.
   */
  readonly requireWorkerpool?: boolean;
  readonly worker?: WorkerpoolAdapterOptions;
}

/**
 * Create a browser embedding queue using Web Workers.
 * Workers are required - this function throws if Web Workers are unavailable.
 */
export function createBrowserEmbeddingQueue(
  options: CreateBrowserEmbeddingQueueOptions = {}
): QueueAdapter {
  if (!supportsWorkers()) {
    throw new Error(
      'Embedding queue requires Web Workers; this environment does not support them.'
    );
  }
  if (!(typeof options.worker?.workerUrl === 'string' && options.worker.workerUrl.length > 0)) {
    throw new Error('createBrowserEmbeddingQueue requires an explicit worker.workerUrl.');
  }
  return createLazyWorkerpoolAdapter(options.worker);
}

function createLazyWorkerpoolAdapter(options: WorkerpoolAdapterOptions): QueueAdapter {
  type ProgressListener = Parameters<QueueAdapter['onProgress']>[0];

  let loadedAdapter: QueueAdapter | null = null;
  let adapterPromise: Promise<QueueAdapter> | null = null;
  let canceled = false;
  let disposed = false;
  let paused = false;
  const listeners = new Map<ProgressListener, (() => void) | null>();

  const attachListeners = (adapter: QueueAdapter): void => {
    for (const [listener, unsubscribe] of listeners.entries()) {
      unsubscribe?.();
      listeners.set(listener, adapter.onProgress(listener));
    }
  };

  const ensureAdapter = async (): Promise<QueueAdapter> => {
    if (disposed) {
      throw new Error('Adapter has been disposed');
    }
    if (canceled) {
      throw new Error('Adapter has been canceled');
    }
    if (loadedAdapter) {
      return loadedAdapter;
    }
    if (!adapterPromise) {
      adapterPromise = import('./adapters/browser-workerpool')
        .then(({ createWorkerpoolAdapter }) => {
          const adapter = createWorkerpoolAdapter(options);
          loadedAdapter = adapter;
          if (paused) {
            adapter.pause();
          }
          attachListeners(adapter);
          return adapter;
        })
        .catch((error: unknown) => {
          for (const [listener, unsubscribe] of listeners.entries()) {
            unsubscribe?.();
            listeners.set(listener, null);
          }
          adapterPromise = null;
          loadedAdapter = null;
          throw error;
        });
    }
    return adapterPromise;
  };

  const getBootstrappedAdapterOrNull = async (): Promise<QueueAdapter | null> => {
    if (loadedAdapter) {
      return loadedAdapter;
    }
    if (!adapterPromise) {
      return null;
    }
    try {
      return await adapterPromise;
    } catch {
      return null;
    }
  };

  return {
    async add(task, addOptions) {
      const adapter = await ensureAdapter();
      return adapter.add(task, addOptions);
    },
    async addBulk(tasks, addOptions) {
      const adapter = await ensureAdapter();
      return adapter.addBulk(tasks, addOptions);
    },
    async cancel() {
      canceled = true;
      const adapter = await getBootstrappedAdapterOrNull();
      if (!adapter) {
        return;
      }
      await adapter.cancel();
    },
    async dispose() {
      disposed = true;
      const adapter = await getBootstrappedAdapterOrNull();
      if (!adapter) {
        return;
      }
      // Prefer the adapter's explicit dispose when present; older adapters
      // without one fall back to cancel(), which has the same terminate semantics.
      if (adapter.dispose) {
        await adapter.dispose();
      } else {
        await adapter.cancel();
      }
    },
    async drain() {
      const adapter = await getBootstrappedAdapterOrNull();
      if (!adapter) {
        return;
      }
      await adapter.drain();
    },
    get isPaused() {
      return loadedAdapter?.isPaused ?? paused;
    },
    get isProcessing() {
      return loadedAdapter?.isProcessing ?? false;
    },
    onProgress(listener) {
      listeners.set(listener, null);
      if (loadedAdapter) {
        listeners.set(listener, loadedAdapter.onProgress(listener));
      }
      return () => {
        const unsubscribe = listeners.get(listener);
        unsubscribe?.();
        listeners.delete(listener);
      };
    },
    pause() {
      paused = true;
      loadedAdapter?.pause();
    },
    resume() {
      paused = false;
      loadedAdapter?.resume();
    },
  };
}
