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

/** Observe acquisition and report fresh failures immediately, before later boot work. */
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

/** Initial rendering follows readiness or failure, unless graceful quit has begun. */
export async function createInitialWindowAfterNativeReader<T>(
  readiness: Promise<NativeReaderStartupOutcome>,
  createWindow: () => Promise<T>,
  onSettled: (outcome: NativeReaderStartupOutcome) => void,
  isShuttingDown: () => boolean
): Promise<T | undefined> {
  const outcome = await readiness;
  if (isShuttingDown()) {
    return undefined;
  }
  onSettled(outcome);
  return createWindow();
}
