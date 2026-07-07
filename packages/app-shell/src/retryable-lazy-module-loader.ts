export interface RetryableLazyModuleLoader<TModule> {
  load: () => Promise<TModule>;
}

export function createRetryableLazyModuleLoader<TModule>(
  importer: () => Promise<TModule>
): RetryableLazyModuleLoader<TModule> {
  let cachedPromise: Promise<TModule> | null = null;

  return {
    load(): Promise<TModule> {
      if (cachedPromise) {
        return cachedPromise;
      }

      cachedPromise = importer().catch((error: unknown) => {
        cachedPromise = null;
        throw error;
      });

      return cachedPromise;
    },
  };
}
