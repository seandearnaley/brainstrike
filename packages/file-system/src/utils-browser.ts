import type { DirectoryReadOptions } from '@brainstrike/types';

/**
 * Concurrency limiter shared across adapters.
 * max <= 0 or non-finite means unlimited concurrency.
 */
export function createLimiter(max: number) {
  if (!Number.isFinite(max) || max <= 0) {
    return async <T>(task: () => Promise<T>): Promise<T> => task();
  }
  let active = 0;
  const queue: Array<() => void> = [];
  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            const next = queue.shift();
            if (next) {
              next();
            }
          });
      };
      if (active < max) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

export function normalizeDirectoryReadOptions(options?: DirectoryReadOptions) {
  const includeMetadata = options?.includeMetadata ?? true;
  const rawConcurrency = options?.concurrency ?? 64;
  const concurrency = Number.isFinite(rawConcurrency) ? Math.floor(rawConcurrency) : Number.NaN;
  const limiter = createLimiter(concurrency);
  return {
    concurrency,
    includeMetadata,
    limiter,
  };
}
