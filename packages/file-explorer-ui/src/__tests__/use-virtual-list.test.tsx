import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { useVirtualList } from '../use-virtual-list';

interface TestComponentProps {
  itemCount: number;
  rowHeight: number;
  overscan?: number;
  onUpdate: (range: { start: number; end: number }) => void;
}

function TestComponent({ itemCount, rowHeight, overscan, onUpdate }: TestComponentProps) {
  const { containerRef, range } = useVirtualList(itemCount, rowHeight, overscan);

  useEffect(() => {
    onUpdate(range);
  }, [range, onUpdate]);

  return <div ref={containerRef} data-testid="container" />;
}

describe('useVirtualList', () => {
  it('applies overscan above and below the visible range', () => {
    const updates: { start: number; end: number }[] = [];
    render(
      <TestComponent
        itemCount={100}
        rowHeight={10}
        overscan={2}
        onUpdate={(r) => updates.push(r)}
      />
    );

    const container = screen.getByTestId('container');
    Object.defineProperty(container, 'clientHeight', { value: 50 });
    act(() => {
      container.scrollTop = 100;
      fireEvent.scroll(container);
    });

    const last = updates[updates.length - 1];
    expect(last).toEqual({ start: 8, end: 17 });
  });

  it('clamps overscan within bounds', () => {
    const updates: { start: number; end: number }[] = [];
    render(
      <TestComponent itemCount={20} rowHeight={10} overscan={3} onUpdate={(r) => updates.push(r)} />
    );

    const container = screen.getByTestId('container');
    Object.defineProperty(container, 'clientHeight', { value: 50 });
    act(() => {
      container.scrollTop = 190;
      fireEvent.scroll(container);
    });

    const last = updates[updates.length - 1];
    expect(last).toEqual({ start: 16, end: 19 });
  });
});
