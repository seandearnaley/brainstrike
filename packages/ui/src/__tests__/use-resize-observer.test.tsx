import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResizeObserver } from '../hooks/use-resize-observer';

// Store the ResizeObserver mock for manipulation in tests
let mockResizeObserverCallback: ResizeObserverCallback | null = null;
let mockObserve: ReturnType<typeof vi.fn>;
let mockDisconnect: ReturnType<typeof vi.fn>;

// Mock ResizeObserver
class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    mockResizeObserverCallback = callback;
  }
  observe = mockObserve;
  unobserve = vi.fn();
  disconnect = mockDisconnect;
}

// Mock requestAnimationFrame
let rafCallback: FrameRequestCallback | null = null;
let rafId = 0;

/**
 * Test helper to create a mock ResizeObserverEntry.
 * Reduces duplication of type assertions across tests.
 */
function createMockEntry(
  element: Element,
  dimensions: { width: number; height: number }
): ResizeObserverEntry {
  return {
    contentRect: dimensions,
    target: element,
  } as unknown as ResizeObserverEntry;
}

describe('useResizeObserver', () => {
  beforeEach(() => {
    mockObserve = vi.fn();
    mockDisconnect = vi.fn();
    mockResizeObserverCallback = null;
    rafCallback = null;
    rafId = 0;

    // Setup ResizeObserver mock
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    // Setup requestAnimationFrame mock
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallback = cb;
      return ++rafId;
    });

    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('observes the element when ref is provided', () => {
    const element = document.createElement('div');
    const ref = { current: element };
    const onResize = vi.fn();

    renderHook(() => useResizeObserver(ref, onResize));

    expect(mockObserve).toHaveBeenCalledWith(element);
  });

  it('does not observe when ref is null', () => {
    const ref = { current: null };
    const onResize = vi.fn();

    renderHook(() => useResizeObserver(ref, onResize));

    expect(mockObserve).not.toHaveBeenCalled();
  });

  it('observes when ref is populated after initial mount', () => {
    const ref = { current: null as HTMLDivElement | null };
    const onResize = vi.fn();

    const { rerender } = renderHook(() => useResizeObserver(ref, onResize));

    expect(mockObserve).not.toHaveBeenCalled();

    const element = document.createElement('div');
    ref.current = element;
    rerender();

    expect(mockObserve).toHaveBeenCalledWith(element);
  });

  it('does not schedule attachment polling when ref never populates', () => {
    const ref = { current: null as HTMLDivElement | null };
    const onResize = vi.fn();

    renderHook(() => useResizeObserver(ref, onResize));

    expect(rafId).toBe(0);
    expect(rafCallback).toBeNull();
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it('disconnects observer on unmount', () => {
    const element = document.createElement('div');
    const ref = { current: element };
    const onResize = vi.fn();

    const { unmount } = renderHook(() => useResizeObserver(ref, onResize));

    unmount();

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('calls onResize with the last entry after RAF', () => {
    const element = document.createElement('div');
    const ref = { current: element };
    const onResize = vi.fn();

    renderHook(() => useResizeObserver(ref, onResize));

    // Simulate ResizeObserver firing
    const mockEntry = createMockEntry(element, { width: 100, height: 200 });

    mockResizeObserverCallback?.([mockEntry], {} as ResizeObserver);

    // onResize should not be called yet (waiting for RAF)
    expect(onResize).not.toHaveBeenCalled();

    // Execute the RAF callback
    rafCallback?.(performance.now());

    expect(onResize).toHaveBeenCalledWith(mockEntry);
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('batches multiple resize events into single RAF callback', () => {
    const element = document.createElement('div');
    const ref = { current: element };
    const onResize = vi.fn();

    renderHook(() => useResizeObserver(ref, onResize));

    const mockEntry1 = createMockEntry(element, { width: 100, height: 200 });
    const mockEntry2 = createMockEntry(element, { width: 150, height: 250 });

    // Simulate multiple ResizeObserver events
    mockResizeObserverCallback?.([mockEntry1], {} as ResizeObserver);
    mockResizeObserverCallback?.([mockEntry2], {} as ResizeObserver);

    // Should have cancelled the first RAF and scheduled a new one
    expect(cancelAnimationFrame).toHaveBeenCalled();

    // Execute the RAF callback - should only call with the last entry
    rafCallback?.(performance.now());

    expect(onResize).toHaveBeenCalledWith(mockEntry2);
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('cancels pending RAF on unmount', () => {
    const element = document.createElement('div');
    const ref = { current: element };
    const onResize = vi.fn();

    const { unmount } = renderHook(() => useResizeObserver(ref, onResize));

    // Simulate ResizeObserver firing to schedule RAF
    const mockEntry = createMockEntry(element, { width: 100, height: 200 });

    mockResizeObserverCallback?.([mockEntry], {} as ResizeObserver);

    // Unmount before RAF executes
    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it('uses the latest callback without recreating observer', () => {
    const element = document.createElement('div');
    const ref = { current: element };
    const onResize1 = vi.fn();
    const onResize2 = vi.fn();

    const { rerender } = renderHook(({ callback }) => useResizeObserver(ref, callback), {
      initialProps: { callback: onResize1 },
    });

    // Initial observe call
    expect(mockObserve).toHaveBeenCalledTimes(1);

    // Update callback
    rerender({ callback: onResize2 });

    // Should not have re-observed (observer not recreated)
    expect(mockObserve).toHaveBeenCalledTimes(1);

    // Simulate resize
    const mockEntry = createMockEntry(element, { width: 100, height: 200 });

    mockResizeObserverCallback?.([mockEntry], {} as ResizeObserver);
    rafCallback?.(performance.now());

    // Should call the new callback, not the old one
    expect(onResize1).not.toHaveBeenCalled();
    expect(onResize2).toHaveBeenCalledWith(mockEntry);
  });

  it('processes the last entry when multiple entries are passed', () => {
    const element = document.createElement('div');
    const ref = { current: element };
    const onResize = vi.fn();

    renderHook(() => useResizeObserver(ref, onResize));

    const mockEntry1 = createMockEntry(element, { width: 100, height: 200 });
    const mockEntry2 = createMockEntry(element, { width: 150, height: 250 });

    // Pass multiple entries in a single callback (rare but possible)
    mockResizeObserverCallback?.([mockEntry1, mockEntry2], {} as ResizeObserver);
    rafCallback?.(performance.now());

    // Should only call with the last entry
    expect(onResize).toHaveBeenCalledWith(mockEntry2);
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('re-observes when element ref changes', () => {
    const element1 = document.createElement('div');
    const element2 = document.createElement('div');
    const onResize = vi.fn();

    const ref = { current: element1 as HTMLDivElement | null };

    const { rerender } = renderHook(() => useResizeObserver(ref, onResize));

    expect(mockObserve).toHaveBeenCalledWith(element1);
    expect(mockObserve).toHaveBeenCalledTimes(1);

    ref.current = element2;
    rerender();

    // Should have disconnected old observer and observed new element
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockObserve).toHaveBeenCalledWith(element2);
  });

  it('handles ref changing from element to null', () => {
    const element = document.createElement('div');
    const onResize = vi.fn();

    const ref = { current: element as HTMLDivElement | null };

    const { rerender } = renderHook(() => useResizeObserver(ref, onResize));

    expect(mockObserve).toHaveBeenCalledWith(element);

    ref.current = null;
    rerender();

    // Should have disconnected
    expect(mockDisconnect).toHaveBeenCalled();
  });

  describe('disabled option', () => {
    it('does not observe when disabled is true', () => {
      const element = document.createElement('div');
      const ref = { current: element };
      const onResize = vi.fn();

      renderHook(() => useResizeObserver(ref, onResize, { disabled: true }));

      expect(mockObserve).not.toHaveBeenCalled();
    });

    it('starts observing when disabled changes from true to false', () => {
      const element = document.createElement('div');
      const ref = { current: element };
      const onResize = vi.fn();

      const { rerender } = renderHook(
        ({ disabled }) => useResizeObserver(ref, onResize, { disabled }),
        { initialProps: { disabled: true } }
      );

      expect(mockObserve).not.toHaveBeenCalled();

      // Enable observation
      rerender({ disabled: false });

      expect(mockObserve).toHaveBeenCalledWith(element);
    });

    it('disconnects when disabled changes from false to true', () => {
      const element = document.createElement('div');
      const ref = { current: element };
      const onResize = vi.fn();

      const { rerender } = renderHook(
        ({ disabled }) => useResizeObserver(ref, onResize, { disabled }),
        { initialProps: { disabled: false } }
      );

      expect(mockObserve).toHaveBeenCalledWith(element);

      // Disable observation
      rerender({ disabled: true });

      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('does not receive resize events when disabled', () => {
      const element = document.createElement('div');
      const ref = { current: element };
      const onResize = vi.fn();

      renderHook(() => useResizeObserver(ref, onResize, { disabled: true }));

      // Try to simulate a resize (shouldn't work since we never observed)
      const mockEntry = createMockEntry(element, { width: 100, height: 200 });

      // Since we never observed, mockResizeObserverCallback should be null
      // or if a new observer was created (it wasn't), calling it shouldn't trigger our callback
      mockResizeObserverCallback?.([mockEntry], {} as ResizeObserver);
      rafCallback?.(performance.now());

      expect(onResize).not.toHaveBeenCalled();
    });
  });
});
