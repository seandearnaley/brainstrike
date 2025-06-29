export function createDebounce<T extends unknown[]>(
  fn: (...args: T) => void | Promise<void>,
  delay: number
) {
  let timeoutId: NodeJS.Timeout | null = null;
  let pendingResolve: (() => void) | null = null;

  const run = (...args: T) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    new Promise<void>((resolve) => {
      pendingResolve = resolve;
      timeoutId = setTimeout(async () => {
        try {
          await fn(...args);
        } catch {
          // Ignore errors from the debounced function to prevent unhandled rejections
        }
        timeoutId = null;
        pendingResolve = null;
        resolve();
      }, delay);
    });
  };

  const flush = async () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;

      // If we have a pending promise, we need to resolve it immediately
      // since we cancelled the timeout that would have resolved it
      if (pendingResolve) {
        pendingResolve();
        pendingResolve = null;
      }
    }
  };

  return { run, flush };
}
