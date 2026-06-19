/**
 * Shared test-only type that exposes the internal Zustand persist API surface.
 *
 * Zustand's `persist` middleware attaches runtime helpers that aren't part of
 * the public type. This generic lets tests access `getOptions`, `clearStorage`,
 * etc. without duplicating the boilerplate in every store test file.
 */
export type PersistApi<T> = T & {
  persist?: {
    getOptions?: () => {
      migrate?: (persistedState: unknown, version: number) => unknown;
      name?: string;
      storage?: {
        getItem: (name: string) => string | null;
        setItem: (name: string, value: string) => void;
        removeItem: (name: string) => void;
      };
      version?: number;
    };
    hasHydrated?: () => boolean;
    rehydrate?: () => Promise<void> | void;
    clearStorage?: () => void;
  };
};
