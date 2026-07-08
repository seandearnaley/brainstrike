export interface DebounceOptions {
  onError?: (error: unknown) => void;
}

export function createDebounce<Args extends unknown[]>(
  fn: (...args: Args) => unknown | Promise<unknown>,
  delay: number,
  options?: DebounceOptions
): { run: (...args: Args) => void; flush: () => Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let latestArgs: Args | null = null;

  const run = (...args: Args) => {
    latestArgs = args;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      if (latestArgs) {
        try {
          await fn(...latestArgs);
        } catch (error: unknown) {
          options?.onError?.(error);
        }
        latestArgs = null;
      }
      timer = undefined;
    }, delay);
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (latestArgs) {
      try {
        await fn(...latestArgs);
      } catch (error: unknown) {
        options?.onError?.(error);
      }
      latestArgs = null;
    }
  };

  return { flush, run };
}
