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
    const mockEntry = {
      contentRect: { width: 100, height: 200 },
      target: element,
    } as unknown as ResizeObserverEntry;

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

    const mockEntry1 = {
      contentRect: { width: 100, height: 200 },
      target: element,
    } as unknown as ResizeObserverEntry;

    const mockEntry2 = {
      contentRect: { width: 150, height: 250 },
      target: element,
    } as unknown as ResizeObserverEntry;

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
    const mockEntry = {
      contentRect: { width: 100, height: 200 },
      target: element,
    } as unknown as ResizeObserverEntry;

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
    const mockEntry = {
      contentRect: { width: 100, height: 200 },
      target: element,
    } as unknown as ResizeObserverEntry;

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

    const mockEntry1 = {
      contentRect: { width: 100, height: 200 },
      target: element,
    } as unknown as ResizeObserverEntry;

    const mockEntry2 = {
      contentRect: { width: 150, height: 250 },
      target: element,
    } as unknown as ResizeObserverEntry;

    // Pass multiple entries in a single callback (rare but possible)
    mockResizeObserverCallback?.([mockEntry1, mockEntry2], {} as ResizeObserver);
    rafCallback?.(performance.now());

    // Should only call with the last entry
    expect(onResize).toHaveBeenCalledWith(mockEntry2);
    expect(onResize).toHaveBeenCalledTimes(1);
  });
});
