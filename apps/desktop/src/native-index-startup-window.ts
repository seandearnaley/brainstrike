import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';

export type NativeReaderStartupOutcome =
  | { readonly kind: 'ready' }
  | { readonly error: unknown; readonly kind: 'unavailable' };

/** The two initial acquisition subscribers report each owned error object once. */
export function createNativeStartupFailureReporter(
  report: (error: unknown) => void
): (error: unknown) => void {
  const reported = new WeakSet<object>();
  return (error: unknown): void => {
    const cause =
      error instanceof NativeIndexRefusalError && error.cause !== undefined ? error.cause : error;
    if ((typeof cause === 'object' && cause !== null) || typeof cause === 'function') {
      if (reported.has(cause)) {
        return;
      }
      reported.add(cause);
    }
    report(cause);
  };
}

/**
 * Observe the initial reader acquisition and report a fresh failure at once. The first window
 * never waits for it (owner decision 7.3(i)); the renderer shows the index's state instead.
 */
export function observeNativeReaderStartup(
  readiness: Promise<unknown>,
  onUnavailable: (error: unknown) => void
): Promise<NativeReaderStartupOutcome> {
  return readiness.then(
    () => ({ kind: 'ready' }),
    (error: unknown) => {
      onUnavailable(error);
      return { error, kind: 'unavailable' };
    }
  );
}
