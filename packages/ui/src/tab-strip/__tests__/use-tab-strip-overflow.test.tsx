import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import {
  readTabStripOverflow,
  tabStripOverflowMaskStyle,
  useTabStripOverflow,
} from '../use-tab-strip-overflow';

function setGeometry(element: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth });
}

function Probe({ contentKey }: { readonly contentKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const overflow = useTabStripOverflow(ref, contentKey);
  return (
    <div
      data-end={String(overflow.end)}
      data-start={String(overflow.start)}
      data-testid="scroller"
      ref={ref}
    />
  );
}

describe('readTabStripOverflow', () => {
  it('reports each overflowing edge with a 1px tolerance', () => {
    const element = document.createElement('div');
    setGeometry(element, 500, 200);
    element.scrollLeft = 0;
    expect(readTabStripOverflow(element)).toEqual({ end: true, start: false });
    element.scrollLeft = 150;
    expect(readTabStripOverflow(element)).toEqual({ end: true, start: true });
    element.scrollLeft = 300;
    expect(readTabStripOverflow(element)).toEqual({ end: false, start: true });
  });
});

describe('tabStripOverflowMaskStyle', () => {
  it('fades only the overflowing edges and nothing when nothing overflows', () => {
    expect(tabStripOverflowMaskStyle({ end: false, start: false })).toBeUndefined();
    expect(tabStripOverflowMaskStyle({ end: true, start: false })?.maskImage).toBe(
      'linear-gradient(to right, #000 0, #000 calc(100% - 24px), transparent 100%)'
    );
    expect(tabStripOverflowMaskStyle({ end: false, start: true })?.maskImage).toBe(
      'linear-gradient(to right, transparent 0, #000 24px, #000 100%)'
    );
  });
});

describe('useTabStripOverflow', () => {
  it('re-measures on scroll', () => {
    const view = render(<Probe contentKey="a" />);
    const scroller = screen.getByTestId('scroller');
    setGeometry(scroller, 500, 200);
    view.rerender(<Probe contentKey="b" />);
    expect(scroller).toHaveAttribute('data-end', 'true');
    act(() => {
      scroller.scrollLeft = 300;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(scroller).toHaveAttribute('data-start', 'true');
    expect(scroller).toHaveAttribute('data-end', 'false');
  });

  it('maps vertical wheel input to horizontal scroll and consumes it only when it moves', () => {
    render(<Probe contentKey="a" />);
    const scroller = screen.getByTestId('scroller');
    setGeometry(scroller, 500, 200);
    scroller.scrollLeft = 0;
    const down = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    act(() => {
      scroller.dispatchEvent(down);
    });
    expect(scroller.scrollLeft).toBe(120);
    expect(down.defaultPrevented).toBe(true);

    scroller.scrollLeft = 300;
    const pastEnd = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 50 });
    act(() => {
      scroller.dispatchEvent(pastEnd);
    });
    expect(scroller.scrollLeft).toBe(300);
    expect(pastEnd.defaultPrevented).toBe(false);
  });

  it('scrolls a page-mode wheel notch by one scroller width', () => {
    render(<Probe contentKey="a" />);
    const scroller = screen.getByTestId('scroller');
    setGeometry(scroller, 500, 200);
    scroller.scrollLeft = 0;
    const page = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: 2,
      deltaY: 1,
    });
    act(() => {
      scroller.dispatchEvent(page);
    });
    expect(scroller.scrollLeft).toBe(200);
    expect(page.defaultPrevented).toBe(true);
  });

  it('leaves horizontal-dominant (trackpad) input to native scrolling', () => {
    render(<Probe contentKey="a" />);
    const scroller = screen.getByTestId('scroller');
    setGeometry(scroller, 500, 200);
    scroller.scrollLeft = 0;
    const swipe = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 80,
      deltaY: 10,
    });
    act(() => {
      scroller.dispatchEvent(swipe);
    });
    expect(swipe.defaultPrevented).toBe(false);
    expect(scroller.scrollLeft).toBe(0);
  });

  it('leaves wheel input alone when nothing overflows', () => {
    render(<Probe contentKey="a" />);
    const scroller = screen.getByTestId('scroller');
    setGeometry(scroller, 200, 200);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    act(() => {
      scroller.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(false);
  });
});
