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
      merge?: (persistedState: unknown, currentState: unknown) => unknown;
      migrate?: (persistedState: unknown, version: number) => unknown;
      name?: string;
      partialize?: (state: unknown) => unknown;
      storage?: {
        getItem: (name: string) => PersistedStoreSnapshot | null;
        setItem: (name: string, value: PersistedStoreSnapshot) => Promise<void> | void;
        removeItem: (name: string) => Promise<void> | void;
      };
      version?: number;
    };
    hasHydrated?: () => boolean;
    rehydrate?: () => Promise<void> | void;
    clearStorage?: () => void;
  };
};

export interface PersistedStoreSnapshot {
  state: Record<string, unknown>;
  version: number;
}
