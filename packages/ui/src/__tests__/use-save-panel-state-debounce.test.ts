import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelPersistenceAdapter } from '../hooks/panel-persistence-adapters';
import { useSavePanelState } from '../hooks/use-save-panel-state';
import type { PanelPersistenceState } from '../types/panel';

// Regression tests for the createDebounce stability fix.
// The bug: createDebounce was called bare in the hook body, creating a new
// debounce instance (with a new timer) on every render. This defeated debouncing
// entirely — rapid calls would each start their own timer instead of resetting one.

describe('useSavePanelState debounce stability', () => {
  const DEBOUNCE_MS = 250;

  let mockAdapter: PanelPersistenceAdapter;
  let onSaved: (state: PanelPersistenceState) => void;

  const makeState = (sizes: number[]): PanelPersistenceState => ({
    showConsole: false,
    showLeftPanel: true,
    showRightPanel: false,
    sizes,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    onSaved = vi.fn();
    mockAdapter = {
      flush: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces multiple persist calls into a single adapter.save', () => {
    const { result } = renderHook(() => useSavePanelState(onSaved, () => null, mockAdapter));

    // Rapidly call persist 5 times with different sizes
    act(() => {
      result.current.persist(makeState([25, 20, 20]));
      result.current.persist(makeState([26, 20, 20]));
      result.current.persist(makeState([27, 20, 20]));
      result.current.persist(makeState([28, 20, 20]));
      result.current.persist(makeState([29, 20, 20]));
    });

    // Before debounce fires, adapter.save should NOT have been called
    expect(mockAdapter.save).not.toHaveBeenCalled();

    // Advance past debounce delay
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    });

    // Exactly one save call with the LAST state
    expect(mockAdapter.save).toHaveBeenCalledTimes(1);
    expect(mockAdapter.save).toHaveBeenCalledWith(makeState([29, 20, 20]));
  });

  it('uses a stable debounce instance across re-renders', () => {
    // This is the core regression test: if createDebounce is called on every render,
    // each render creates a new timer, so the previous timer still fires.
    // With the fix (useRef), re-renders don't create new debounce instances.
    const { result, rerender } = renderHook(
      ({ adapter }) => useSavePanelState(onSaved, () => null, adapter),
      { initialProps: { adapter: mockAdapter } }
    );

    // Call persist
    act(() => {
      result.current.persist(makeState([30, 20, 20]));
    });

    // Force a re-render (simulates parent component re-rendering)
    rerender({ adapter: mockAdapter });
    rerender({ adapter: mockAdapter });
    rerender({ adapter: mockAdapter });

    // Call persist again — should reset the SAME timer, not create a new one
    act(() => {
      result.current.persist(makeState([35, 20, 20]));
    });

    // Advance past original debounce window
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    });

    // Should be exactly ONE save call (the second persist reset the timer)
    // If the bug were present, there would be TWO calls: one from the old
    // timer (sizes [30,...]) and one from the new timer (sizes [35,...])
    expect(mockAdapter.save).toHaveBeenCalledTimes(1);
    expect(mockAdapter.save).toHaveBeenCalledWith(makeState([35, 20, 20]));
  });

  it('calls the latest save function even after adapter changes', () => {
    const adapter1: PanelPersistenceAdapter = {
      flush: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const adapter2: PanelPersistenceAdapter = {
      flush: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const { result, rerender } = renderHook(
      ({ adapter }) => useSavePanelState(onSaved, () => null, adapter),
      { initialProps: { adapter: adapter1 } }
    );

    // Persist with adapter1
    act(() => {
      result.current.persist(makeState([25, 20, 20]));
    });

    // Switch to adapter2 before debounce fires
    rerender({ adapter: adapter2 });

    // Advance past debounce
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    });

    // The save should go through adapter2 (the latest), not adapter1
    // This verifies the saveRef pattern works correctly
    expect(adapter1.save).not.toHaveBeenCalled();
    expect(adapter2.save).toHaveBeenCalledTimes(1);
  });

  it('flush immediately triggers save without waiting for debounce', () => {
    const { result } = renderHook(() => useSavePanelState(onSaved, () => null, mockAdapter));

    act(() => {
      result.current.persist(makeState([40, 20, 20]));
    });

    expect(mockAdapter.save).not.toHaveBeenCalled();

    // Flush should trigger immediate save
    act(() => {
      result.current.flush();
    });

    // Need to let the async save resolve
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(mockAdapter.save).toHaveBeenCalledTimes(1);
    expect(mockAdapter.save).toHaveBeenCalledWith(makeState([40, 20, 20]));
  });
});
