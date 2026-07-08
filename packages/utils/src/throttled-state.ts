/**
 * Throttled state update utilities for React.
 *
 * These utilities help reduce re-renders by batching rapid state updates,
 * which is critical for performance during high-frequency operations like
 * file imports where progress updates can trigger 1000+ renders.
 */

/** React-compatible SetStateAction type (value or updater function) */
export type SetStateAction<T> = T | ((prevState: T) => T);

/** React-compatible Dispatch type for state setters */
export type Dispatch<A> = (value: A) => void;

export interface ThrottledSetState<T> {
  /** Cancel any pending update */
  cancel: () => void;
  /** Force immediate flush of pending update */
  flush: () => void;
  /** Get diagnostic info about timer state (for testing/debugging) */
  getDiagnostics: () => ThrottledStateDiagnostics;
  /** Get current pending value (if any) */
  getPending: () => T | undefined;
  /** Update state (throttled) */
  update: Dispatch<SetStateAction<T>>;
}

/**
 * Diagnostic information about the throttled state.
 * Useful for testing and debugging timer cleanup.
 */
export interface ThrottledStateDiagnostics {
  /** Whether there is a pending value waiting to be flushed */
  hasPending: boolean;
  /** Whether a timer is currently scheduled */
  hasScheduledTimer: boolean;
  /** Timestamp of last emit (0 if never emitted) */
  lastEmitTime: number;
}

export interface ThrottleOptions {
  /** Minimum time between updates in ms (default: 100) */
  intervalMs?: number;
}

/**
 * Create a throttled state setter that batches rapid updates.
 *
 * Instead of calling setState on every update, this collects updates
 * and only applies them at most once per interval.
 *
 * @example
 * ```tsx
 * const [progress, setProgress] = useState(0);
 * const throttledRef = useRef<ThrottledSetState<number>>();
 *
 * useEffect(() => {
 *   throttledRef.current = createThrottledSetState(setProgress, { intervalMs: 100 });
 *   return () => throttledRef.current?.cancel();
 * }, []);
 *
 * // In your loop:
 * throttledRef.current?.update(i / total);
 *
 * // At the end:
 * throttledRef.current?.flush();
 * ```
 */
export function createThrottledSetState<T>(
  setState: Dispatch<SetStateAction<T>>,
  options: ThrottleOptions = {}
): ThrottledSetState<T> {
  const { intervalMs = 100 } = options;

  let pendingValue: T | undefined;
  let hasPending = false;
  let lastEmitTime = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (hasPending) {
      setState(pendingValue as T);
      hasPending = false;
      pendingValue = undefined;
      lastEmitTime = Date.now();
    }
  };

  const cancel = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    hasPending = false;
    pendingValue = undefined;
  };

  const update = (valueOrUpdater: SetStateAction<T>): void => {
    // Resolve the value (handle functional updates)
    const newValue =
      typeof valueOrUpdater === 'function'
        ? (valueOrUpdater as (prev: T) => T)(hasPending ? (pendingValue as T) : (undefined as T))
        : valueOrUpdater;

    pendingValue = newValue;
    hasPending = true;

    const now = Date.now();
    const timeSinceLastEmit = now - lastEmitTime;

    // If enough time has passed, emit immediately
    if (timeSinceLastEmit >= intervalMs) {
      flush();
      return;
    }

    // Otherwise, schedule an emit for the remaining time
    if (!timeoutId) {
      const remaining = intervalMs - timeSinceLastEmit;
      timeoutId = setTimeout(flush, remaining);
    }
  };

  const getPending = (): T | undefined => (hasPending ? pendingValue : undefined);

  const getDiagnostics = (): ThrottledStateDiagnostics => ({
    hasPending,
    hasScheduledTimer: timeoutId !== null,
    lastEmitTime,
  });

  return { cancel, flush, getDiagnostics, getPending, update };
}

/**
 * React hook version of createThrottledSetState.
 * Automatically cleans up on unmount.
 *
 * @example
 * ```tsx
 * const [progress, setProgress] = useState(0);
 * const throttled = useThrottledState(setProgress, { intervalMs: 100 });
 *
 * // In callback:
 * throttled.update(newProgress);
 *
 * // When done:
 * throttled.flush();
 * ```
 */
export function createThrottledStateRef<T>(
  setState: Dispatch<SetStateAction<T>>,
  options: ThrottleOptions = {}
): ThrottledSetState<T> & { cleanup: () => void } {
  const throttled = createThrottledSetState<T>(setState, options);

  return {
    cancel: throttled.cancel,
    cleanup: (): void => {
      throttled.flush(); // Emit final value
      throttled.cancel();
    },
    flush: throttled.flush,
    getDiagnostics: throttled.getDiagnostics,
    getPending: throttled.getPending,
    update: throttled.update,
  };
}
