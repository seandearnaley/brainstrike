import { act, fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVirtualList } from '../tree/use-virtual-list';

type ResizeObserverCallbackRef = ResizeObserverCallback | null;
let resizeObserverCallback: ResizeObserverCallbackRef = null;

interface TestComponentProps {
  itemCount: number;
  onUpdate: (range: { start: number; end: number }) => void;
  overscan?: number;
  rowHeight: number;
}

function TestComponent({ itemCount, rowHeight, overscan, onUpdate }: TestComponentProps) {
  const { containerRef, range } = useVirtualList(itemCount, rowHeight, { overscan: overscan ?? 0 });

  // biome-ignore lint/plugin: Test helper - notify parent of range updates for assertions
  useLayoutEffect(() => {
    onUpdate(range);
  }, [range, onUpdate]);

  return (
    <div
      data-testid="container"
      ref={(element) => {
        if (element) {
          Object.defineProperty(element, 'clientHeight', { configurable: true, value: 50 });
        }
        // Assign through the ref object's mutable current property
        const mutableRef = containerRef as React.MutableRefObject<HTMLDivElement | null>;
        mutableRef.current = element;
      }}
    />
  );
}

describe('useVirtualList', () => {
  // Mock RAF to run synchronously for predictable test behavior
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(performance.now());
      return 0;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    resizeObserverCallback = null;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }

      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('applies overscan above and below the visible range', () => {
    const updates: { start: number; end: number }[] = [];
    render(
      <TestComponent
        itemCount={100}
        onUpdate={(r) => updates.push(r)}
        overscan={2}
        rowHeight={10}
      />
    );

    const container = screen.getByTestId('container');
    Object.defineProperty(container, 'clientHeight', { value: 50 });
    act(() => {
      container.scrollTop = 100;
      fireEvent.scroll(container);
    });

    const last = updates.at(-1);
    expect(last).toEqual({ start: 8, end: 17 });
  });

  it('clamps overscan within bounds', () => {
    const updates: { start: number; end: number }[] = [];
    render(
      <TestComponent itemCount={20} onUpdate={(r) => updates.push(r)} overscan={3} rowHeight={10} />
    );

    const container = screen.getByTestId('container');
    Object.defineProperty(container, 'clientHeight', { value: 50 });
    act(() => {
      container.scrollTop = 190;
      fireEvent.scroll(container);
    });

    const last = updates.at(-1);
    expect(last).toEqual({ start: 16, end: 19 });
  });

  it('updates range once on initial mount', () => {
    const updates: { start: number; end: number }[] = [];
    render(
      <TestComponent itemCount={10} onUpdate={(r) => updates.push(r)} overscan={1} rowHeight={10} />
    );

    const container = screen.getByTestId('container');
    Object.defineProperty(container, 'clientHeight', { value: 50 });
    // flush effects
    act(() => {});

    const last = updates.at(-1);
    expect(last).toEqual({ start: 0, end: 6 });
  });

  it('recomputes range when container height changes', () => {
    const updates: { start: number; end: number }[] = [];
    render(
      <TestComponent
        itemCount={100}
        onUpdate={(r) => updates.push(r)}
        overscan={1}
        rowHeight={10}
      />
    );

    const container = screen.getByTestId('container');
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 90 });

    act(() => {
      resizeObserverCallback?.(
        [{ target: container } as unknown as ResizeObserverEntry],
        {} as ResizeObserver
      );
    });

    const last = updates.at(-1);
    expect(last).toEqual({ start: 0, end: 10 });
  });

  it('returns an empty range when there are no items', () => {
    const updates: { start: number; end: number }[] = [];
    render(
      <TestComponent itemCount={0} onUpdate={(r) => updates.push(r)} overscan={2} rowHeight={10} />
    );

    const last = updates.at(-1);
    expect(last).toEqual({ start: 0, end: -1 });
  });
});
