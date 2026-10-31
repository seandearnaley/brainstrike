/**
 * Zustand's testing guide (https://zustand.docs.pmnd.rs/learn/guides/testing):
 * every store returns to its initial state after each test. The creators are
 * wrapped so each store registers its own reset, and persisted stores lose what
 * they wrote, because `localStorage` is cleared after the stores reset.
 */
import { afterEach, vi } from 'vitest';

interface ResettableStore<State> {
  getInitialState(): State;
  setState(state: State, replace: true): void;
}

const storeResets = vi.hoisted(() => new Set<() => void>());

vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>();
  return { ...zustand, create: resettableCreator(zustand.create) };
});

vi.mock('zustand/vanilla', async (importOriginal) => {
  const vanilla = await importOriginal<typeof import('zustand/vanilla')>();
  return { ...vanilla, createStore: resettableCreator(vanilla.createStore) };
});

vi.mock('zustand/traditional', async (importOriginal) => {
  const traditional = await importOriginal<typeof import('zustand/traditional')>();
  return {
    ...traditional,
    createWithEqualityFn: resettableCreator(traditional.createWithEqualityFn),
  };
});

function registerReset<Store extends ResettableStore<unknown>>(store: Store): Store {
  const initialState = store.getInitialState();
  storeResets.add(() => store.setState(initialState, true));
  return store;
}

/**
 * Wraps a zustand creator, in its direct and its curried `create<T>()(…)` form,
 * so every store it makes registers a reset to its initial state.
 */
function resettableCreator<Creator extends (...args: never[]) => unknown>(
  creator: Creator
): Creator {
  const wrapped = (...args: Parameters<Creator>) => {
    if (args.length === 0) {
      const curried = creator() as (...inner: unknown[]) => ResettableStore<unknown>;
      return (...inner: unknown[]) => registerReset(curried(...inner));
    }
    return registerReset(creator(...args) as ResettableStore<unknown>);
  };
  return wrapped as Creator;
}

afterEach(async () => {
  if (storeResets.size > 0) {
    // Loaded on first use, so a suite with no store never imports React.
    const { act } = await import('react');
    act(() => {
      for (const reset of storeResets) {
        reset();
      }
    });
  }
  globalThis.localStorage?.clear();
});
