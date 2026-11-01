import { createLogger } from '@brainstrike/logging';
import type { StateCreator, StoreMutatorIdentifier } from 'zustand';
import {
  createJSONStorage,
  type PersistOptions,
  type PersistStorage,
  persist,
} from 'zustand/middleware';

/**
 * Every durable renderer key starts with this. Main's Factory Reset wipes this
 * renderer's `localStorage` whole (`clearStorageData`, ADR-0015), so a store made
 * with {@link persistDurable} joins reset by construction and owns no reset code.
 */
export const DURABLE_KEY_PREFIX = 'brainstrike:';

/** A `localStorage` key under {@link DURABLE_KEY_PREFIX}; readers and tests use the same constant. */
export type DurableKey = `${typeof DURABLE_KEY_PREFIX}${string}`;

/** zustand's `persist` options, less the two this factory owns: the key and the storage. */
export type DurableOptions<State, Persisted = State> = Omit<
  PersistOptions<State, Persisted>,
  'name' | 'storage'
> & {
  /** Called when the saved value is not JSON and the store opens on its defaults. */
  readonly onUnreadable?: () => void;
};

const logger = createLogger('DurableStore');

/**
 * This renderer's `window.localStorage` as JSON, except that a saved value that is not
 * JSON reads as nothing saved: zustand's own read rejects, which leaves the store never
 * hydrated, so anything waiting on hydration would wait forever. The discard is logged
 * and reported through `onUnreadable`; the next change overwrites the value. Undefined
 * where there is no `window.localStorage`, and zustand then keeps the state in memory.
 */
function createDurableStorage<Persisted>(
  key: DurableKey,
  onUnreadable: (() => void) | undefined
): PersistStorage<Persisted> | undefined {
  const storage = createJSONStorage<Persisted>(() => window.localStorage);
  if (!storage) {
    return undefined;
  }
  return {
    ...storage,
    getItem: (name) => {
      try {
        return storage.getItem(name);
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        logger.warn('Saved state is not JSON; the store opens on its defaults', { key });
        onUnreadable?.();
        return null;
      }
    },
  };
}

/**
 * zustand's `persist` (https://zustand.docs.pmnd.rs/middlewares/persist) over this
 * renderer's `window.localStorage`, which no store may replace. The one way a renderer
 * store keeps state across reloads.
 */
export function persistDurable<
  State,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  Persisted = State,
>(
  key: DurableKey,
  initializer: StateCreator<State, [...Mps, ['zustand/persist', unknown]], Mcs>,
  options: DurableOptions<State, Persisted> = {}
): StateCreator<State, Mps, [['zustand/persist', Persisted], ...Mcs]> {
  const { onUnreadable, ...persistOptions } = options;
  const storage = createDurableStorage<Persisted>(key, onUnreadable);
  return persist(initializer, {
    ...persistOptions,
    name: key,
    ...(storage ? { storage } : {}),
  });
}
