export function createDebounce<Args extends unknown[]>(
  fn: (...args: Args) => unknown | Promise<unknown>,
  delay: number
): { run: (...args: Args) => void; flush: () => Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let latestArgs: Args | null = null;

  const run = (...args: Args) => {
    latestArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (latestArgs) {
        try {
          await fn(...latestArgs);
        } catch {
          // ignore errors from debounced fn
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
      } catch {
        // ignore errors from debounced fn
      }
      latestArgs = null;
    }
  };

  return { run, flush };
}
