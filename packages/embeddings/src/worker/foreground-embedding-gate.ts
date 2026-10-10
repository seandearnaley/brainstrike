/**
 * Coordinates the desktop background embedding indexer against foreground query
 * embeddings so they never share the GPU.
 *
 * - The worker's `waitForBackgroundPermit('embedding claim')` awaits the gate, so
 *   no NEW indexing batch starts while a query embedding is in flight.
 * - The query handler drains the current in-flight batch (waits for the worker's
 *   `active` flag to clear) before generating, so the GPU is exclusively the query's.
 *
 * Gating only the *claim* permit (never completion) keeps this deadlock-free: an
 * already-claimed batch always finishes and reports idle; only the next is held.
 */

interface ForegroundGateWaiter {
  cleanup: () => void;
  reject: (reason: unknown) => void;
  resolve: () => void;
}

export interface ForegroundEmbeddingGate {
  begin: () => void;
  end: () => void;
  isActive: () => boolean;
  waitUntilInactive: (options?: { signal?: AbortSignal }) => Promise<void>;
}

export interface ForegroundEmbeddingGateOptions {
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  reopenDelayMs?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

const DEFAULT_REOPEN_DELAY_MS = 250;

export function createForegroundEmbeddingGate(
  options: ForegroundEmbeddingGateOptions = {}
): ForegroundEmbeddingGate {
  const reopenDelayMs = options.reopenDelayMs ?? DEFAULT_REOPEN_DELAY_MS;
  const setTimeoutFn = options.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let count = 0;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<ForegroundGateWaiter>();

  const isActive = (): boolean => count > 0 || reopenTimer !== null;

  const clearReopenTimer = (): void => {
    if (reopenTimer !== null) {
      clearTimeoutFn(reopenTimer);
      reopenTimer = null;
    }
  };

  const flushWaiters = (): void => {
    for (const waiter of Array.from(waiters)) {
      waiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve();
    }
  };

  const scheduleReopen = (): void => {
    clearReopenTimer();
    reopenTimer = setTimeoutFn(() => {
      reopenTimer = null;
      if (count === 0) {
        flushWaiters();
      }
    }, reopenDelayMs);
  };

  return {
    begin(): void {
      count += 1;
      clearReopenTimer();
    },
    end(): void {
      count = Math.max(0, count - 1);
      if (count === 0) {
        scheduleReopen();
      }
    },
    isActive,
    waitUntilInactive(waitOptions: { signal?: AbortSignal } = {}): Promise<void> {
      if (!isActive()) {
        return Promise.resolve();
      }
      const { signal } = waitOptions;
      if (signal?.aborted) {
        return Promise.reject(new Error('Foreground embedding gate wait aborted'));
      }
      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          waiters.delete(waiter);
          waiter.cleanup();
          reject(new Error('Foreground embedding gate wait aborted'));
        };
        const waiter: ForegroundGateWaiter = {
          cleanup: () => {
            signal?.removeEventListener('abort', onAbort);
          },
          reject,
          resolve,
        };
        waiters.add(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

export interface WaitForWorkerIdleOptions {
  isActive: () => boolean;
  pollMs?: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

const DEFAULT_IDLE_POLL_MS = 25;

export function waitForWorkerIdle(
  options: WaitForWorkerIdleOptions
): Promise<{ drained: boolean }> {
  const pollMs = options.pollMs ?? DEFAULT_IDLE_POLL_MS;
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason);
  }
  if (!options.isActive()) {
    return Promise.resolve({ drained: true });
  }
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      // Keep the request owner's cancellation discriminator through IPC settlement.
      reject(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const poll = (): void => {
      if (!options.isActive()) {
        cleanup();
        resolve({ drained: true });
        return;
      }
      if (Date.now() - start >= options.timeoutMs) {
        cleanup();
        resolve({ drained: false });
        return;
      }
      pollTimer = setTimeout(poll, pollMs);
    };
    pollTimer = setTimeout(poll, pollMs);
  });
}

export interface RunCoordinatedQueryEmbeddingOptions<T> {
  drainTimeoutMs: number;
  gate: ForegroundEmbeddingGate;
  generate: () => Promise<T>;
  isWorkerActive: () => boolean;
  onDrainTimeout?: () => void;
  pollMs?: number;
  signal?: AbortSignal;
}

export async function runCoordinatedQueryEmbedding<T>(
  options: RunCoordinatedQueryEmbeddingOptions<T>
): Promise<T> {
  options.gate.begin();
  try {
    const idleOptions: WaitForWorkerIdleOptions = {
      isActive: options.isWorkerActive,
      timeoutMs: options.drainTimeoutMs,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const { drained } = await waitForWorkerIdle(idleOptions);
    if (!drained) {
      options.onDrainTimeout?.();
      throw new Error(
        'Background embedding inference did not drain before the foreground query deadline.'
      );
    }
    return await options.generate();
  } finally {
    options.gate.end();
  }
}
