export function createDebounce<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
  delay: number
): { run: (...args: Args) => void; flush: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let latestArgs: Args | null = null;

  const run = (...args: Args) => {
    latestArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (latestArgs) {
        fn(...latestArgs);
        latestArgs = null;
      }
      timer = undefined;
    }, delay);
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (latestArgs) {
      fn(...latestArgs);
      latestArgs = null;
    }
  };

  return { run, flush };
}
