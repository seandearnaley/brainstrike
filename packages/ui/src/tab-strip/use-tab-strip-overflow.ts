import { type CSSProperties, type RefObject, useCallback, useEffect, useState } from 'react';
import { TAB_STRIP_FADE_WIDTH_PX } from './tab-strip-tokens';

export interface TabStripOverflow {
  readonly end: boolean;
  readonly start: boolean;
}

const NO_OVERFLOW: TabStripOverflow = { end: false, start: false };
/** `WheelEvent.DOM_DELTA_LINE`; Firefox reports line deltas for mouse wheels. */
const DOM_DELTA_LINE = 1;
/** `WheelEvent.DOM_DELTA_PAGE`; one notch scrolls one scroller width. */
const DOM_DELTA_PAGE = 2;
const LINE_HEIGHT_PX = 16;

function wheelDeltaToPixels(event: WheelEvent, pageWidth: number): number {
  if (event.deltaMode === DOM_DELTA_LINE) {
    return event.deltaY * LINE_HEIGHT_PX;
  }
  if (event.deltaMode === DOM_DELTA_PAGE) {
    return event.deltaY * pageWidth;
  }
  return event.deltaY;
}

export function readTabStripOverflow(element: HTMLElement): TabStripOverflow {
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  return { end: element.scrollLeft < maxScrollLeft - 1, start: element.scrollLeft > 1 };
}

/**
 * Inline mask so the fades work in every browser without scroll-driven
 * animations. Unprefixed `mask-image` is Baseline 2023 (Chromium 120, Safari
 * 15.4), so no `-webkit-` twin is emitted.
 */
export function tabStripOverflowMaskStyle(overflow: TabStripOverflow): CSSProperties | undefined {
  if (!(overflow.start || overflow.end)) {
    return undefined;
  }
  const fade = `${TAB_STRIP_FADE_WIDTH_PX}px`;
  const start = overflow.start ? `transparent 0, #000 ${fade}` : '#000 0';
  const end = overflow.end ? `#000 calc(100% - ${fade}), transparent 100%` : '#000 100%';
  const image = `linear-gradient(to right, ${start}, ${end})`;
  return { maskImage: image };
}

/**
 * Overflow flags plus wheel→horizontal mapping for the strip scroller. The
 * wheel listener is NATIVE and non-passive: React registers `onWheel` as a
 * passive root listener, so `preventDefault` inside it is ignored.
 */
export function useTabStripOverflow(
  scrollRef: RefObject<HTMLElement | null>,
  contentKey: string
): TabStripOverflow {
  const [overflow, setOverflow] = useState<TabStripOverflow>(NO_OVERFLOW);

  const measure = useCallback((): void => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const next = readTabStripOverflow(element);
    setOverflow((current) =>
      current.start === next.start && current.end === next.end ? current : next
    );
  }, [scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    // Every supported browser and Electron has ResizeObserver; the guard only
    // covers unit-test DOM shims that omit it.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) {
      observer?.observe(element.firstElementChild);
    }
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [contentKey, measure, scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const handleWheel = (event: WheelEvent): void => {
      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      if (maxScrollLeft <= 0) {
        return;
      }
      // Horizontal-dominant input (trackpads, tilt wheels) already scrolls this
      // x-axis scroller natively, with momentum; only translate vertical wheels.
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
        return;
      }
      const delta = wheelDeltaToPixels(event, element.clientWidth);
      if (delta === 0) {
        return;
      }
      const next = Math.min(maxScrollLeft, Math.max(0, element.scrollLeft + delta));
      if (next === element.scrollLeft) {
        return;
      }
      event.preventDefault();
      element.scrollLeft = next;
      measure();
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [measure, scrollRef]);

  return overflow;
}
