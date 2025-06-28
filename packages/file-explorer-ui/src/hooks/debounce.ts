export function createDebounce<T extends unknown[]>(
  fn: (...args: T) => void | Promise<void>,
  delay: number
) {
  let timeoutId: NodeJS.Timeout | null = null;
  let pendingPromise: Promise<void> | null = null;

  const run = (...args: T) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    pendingPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(async () => {
        await fn(...args);
        timeoutId = null;
        pendingPromise = null;
        resolve();
      }, delay);
    });
  };

  const flush = async () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (pendingPromise) {
      await pendingPromise;
    }
  };

  return { run, flush };
}