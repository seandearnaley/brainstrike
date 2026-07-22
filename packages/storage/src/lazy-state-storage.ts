/**
 * Minimal key/value contract accepted by Zustand's `createJSONStorage`.
 * Kept structural so storage consumers do not need a runtime Zustand dependency.
 */
export interface StateStorage<Result = unknown> {
  readonly getItem: (name: string) => string | null | Promise<string | null>;
  readonly removeItem: (name: string) => Result;
  readonly setItem: (name: string, value: string) => Result;
}

/**
 * Defer platform adapter construction until the first persistence operation.
 *
 * A factory that throws is retried on the next operation. Once resolution
 * succeeds, every operation uses that same adapter. Factory and operation
 * failures intentionally propagate to the caller.
 */
export function createLazyStateStorage<Result>(
  factory: () => StateStorage<Result>
): StateStorage<Result> {
  let resolvedStorage: StateStorage<Result> | undefined;
  const resolveStorage = (): StateStorage<Result> => {
    if (resolvedStorage) {
      return resolvedStorage;
    }
    const storage = factory();
    resolvedStorage = storage;
    return storage;
  };

  return {
    getItem: (name: string) => resolveStorage().getItem(name),
    removeItem: (name: string) => resolveStorage().removeItem(name),
    setItem: (name: string, value: string) => resolveStorage().setItem(name, value),
  };
}
