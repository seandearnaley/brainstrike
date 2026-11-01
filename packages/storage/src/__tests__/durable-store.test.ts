import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { persistDurable } from '../durable-store.ts';

const KEY = 'brainstrike:durable-store-test.v1';

interface CounterState {
  count: number;
  increment: () => void;
}

afterEach(() => {
  localStorage.clear();
});

describe('persistDurable', () => {
  it('finishes hydration on defaults when the saved value is not JSON, and the next change overwrites it', () => {
    localStorage.setItem(KEY, '{not json');
    const onUnreadable = vi.fn();

    const useCounter = create<CounterState>()(
      persistDurable(
        KEY,
        (set) => ({ count: 0, increment: () => set((state) => ({ count: state.count + 1 })) }),
        { onUnreadable, version: 1 }
      )
    );

    expect(useCounter.persist.hasHydrated()).toBe(true);
    expect(useCounter.getState().count).toBe(0);
    expect(onUnreadable).toHaveBeenCalledTimes(1);

    useCounter.getState().increment();
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({
      state: { count: 1 },
      version: 1,
    });
  });
});
