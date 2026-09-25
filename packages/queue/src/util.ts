// Re-export isAbortError from shared utils for backwards compatibility
export { isAbortError } from '@brainstrike/utils';

export type Listener<TEvent> = (event: TEvent) => void;

export class ProgressEmitter<TEvent> {
  private readonly listeners = new Set<Listener<TEvent>>();

  add(listener: Listener<TEvent>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: TEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function estimateHardwareConcurrency(): number {
  if (typeof navigator !== 'undefined') {
    const concurrency = Number(
      (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency
    );
    if (Number.isFinite(concurrency) && concurrency > 0) {
      return concurrency;
    }
  }
  return 2;
}

export function supportsWorkers(): boolean {
  // Type-only detection keeps us CSP-safe. Any instantiation errors will be caught during adapter creation.
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

/**
 * Default timeout for worker initialization (30 seconds).
 */
export const DEFAULT_WORKER_READY_TIMEOUT_MS = 30_000;

/**
 * Options for configuring worker ready waiting behavior.
 */
export interface WorkerReadyWaiterOptions {
  /** Default timeout in ms if none provided to waitForReady (default: 30000) */
  readonly defaultTimeoutMs?: number;
  /** Polling interval in ms for checking ready state (default: 50) */
  readonly pollIntervalMs?: number;
}

/**
 * Creates a waitForReady function for a worker client.
 *
 * This utility standardizes the async ready-waiting pattern found across
 * worker port implementations (BST-165).
 *
 * @example
 * ```typescript
 * let ready = false;
 * const waitForReady = createWorkerReadyWaiter(() => ready);
 *
 * // Later, when worker sends 'ready' message:
 * ready = true;
 *
 * // Caller can wait with timeout:
 * const isReady = await waitForReady(5000);
 * ```
 *
 * @param isReady - Function that returns current ready state
 * @param options - Configuration options
 * @returns Async function that resolves when ready or times out
 */
export function createWorkerReadyWaiter(
  isReady: () => boolean,
  options: WorkerReadyWaiterOptions = {}
): (timeoutMs?: number) => Promise<boolean> {
  const { defaultTimeoutMs = DEFAULT_WORKER_READY_TIMEOUT_MS, pollIntervalMs = 50 } = options;

  return async (timeoutMs?: number): Promise<boolean> => {
    // Already ready - fast path
    if (isReady()) {
      return true;
    }

    const timeout = timeoutMs ?? defaultTimeoutMs;
    const deadline = Date.now() + timeout;

    return new Promise<boolean>((resolve) => {
      const checkReady = () => {
        if (isReady()) {
          resolve(true);
          return;
        }

        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }

        setTimeout(checkReady, pollIntervalMs);
      };

      checkReady();
    });
  };
}
