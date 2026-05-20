import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface VirtualRange {
  end: number;
  start: number;
}

export interface UseVirtualListOptions {
  /** Number of rows to render above/below visible area (default: 5) */
  overscan?: number;
}

export interface UseVirtualListReturn {
  containerRef: RefObject<HTMLDivElement | null>;
  offset: number;
  range: VirtualRange;
  totalHeight: number;
}

/**
 * Virtual list hook for efficiently rendering large lists.
 *
 * Performance optimizations:
 * - Uses requestAnimationFrame to batch scroll updates
 * - Default overscan of 5 rows provides buffer for smooth scrolling
 * - Avoids unnecessary re-renders by comparing previous range values
 * - Uses useLayoutEffect for synchronous initial measurement, ensuring the
 *   container dimensions are captured before paint
 */
/** Sentinel value indicating a RAF has been scheduled but the ID is not yet known. */
const RAF_SCHEDULED_SENTINEL = -1;

export function useVirtualList(
  itemCount: number,
  rowHeight: number,
  options: UseVirtualListOptions = {}
): UseVirtualListReturn {
  // Default overscan of 5 provides smooth scrolling buffer
  const { overscan = 5 } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0 });
  const [offset, setOffset] = useState(0);

  // Keep latest configuration in refs so listeners don't need re-binding.
  const configRef = useRef({ itemCount, rowHeight, overscan });
  configRef.current = { itemCount, rowHeight, overscan };

  // Track pending RAF to avoid duplicate frames
  const rafIdRef = useRef<number | null>(null);
  // Track previous values to avoid unnecessary state updates
  const prevRangeRef = useRef<VirtualRange>({ start: 0, end: 0 });
  const prevOffsetRef = useRef(0);

  const calculateRange = useCallback(() => {
    const container = containerRef.current;
    const {
      itemCount: currentItemCount,
      rowHeight: currentRowHeight,
      overscan: currentOverscan,
    } = configRef.current;

    if (!container || currentItemCount <= 0 || currentRowHeight <= 0) {
      const emptyRange: VirtualRange = { start: 0, end: -1 };
      if (
        prevRangeRef.current.start !== emptyRange.start ||
        prevRangeRef.current.end !== emptyRange.end
      ) {
        prevRangeRef.current = emptyRange;
        setRange(emptyRange);
      }
      if (prevOffsetRef.current !== 0) {
        prevOffsetRef.current = 0;
        setOffset(0);
      }
      return;
    }

    const scrollTop = Math.max(0, container.scrollTop);
    const clientHeight = Math.max(0, container.clientHeight);
    const baseStart = Math.floor(scrollTop / currentRowHeight);
    const baseEnd = Math.floor((scrollTop + clientHeight) / currentRowHeight);
    const start = Math.max(0, baseStart - currentOverscan);
    const end = Math.min(currentItemCount - 1, baseEnd + currentOverscan);
    const newOffset = baseStart * currentRowHeight;

    // Only update state if values have changed
    const rangeChanged = start !== prevRangeRef.current.start || end !== prevRangeRef.current.end;
    const offsetChanged = newOffset !== prevOffsetRef.current;

    if (rangeChanged || offsetChanged) {
      if (rangeChanged) {
        const nextRange: VirtualRange = { start, end };
        prevRangeRef.current = nextRange;
        setRange(nextRange);
      }
      if (offsetChanged) {
        prevOffsetRef.current = newOffset;
        setOffset(newOffset);
      }
    }
  }, []);

  const scheduleRangeCalculation = useCallback(() => {
    if (rafIdRef.current !== null) {
      return;
    }
    // Use a sentinel first to handle sync RAF mocks in tests.
    rafIdRef.current = RAF_SCHEDULED_SENTINEL;
    const rafId = requestAnimationFrame(() => {
      rafIdRef.current = null;
      calculateRange();
    });
    if (rafIdRef.current === RAF_SCHEDULED_SENTINEL) {
      rafIdRef.current = rafId;
    }
  }, [calculateRange]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      // Use RAF to batch scroll updates and avoid layout thrashing
      scheduleRangeCalculation();
    };

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        // Container height changes can invalidate the visible range window.
        scheduleRangeCalculation();
      });
      resizeObserver.observe(container);
    }

    container.addEventListener('scroll', handleScroll, { passive: true });

    // Synchronous initial measurement prevents first-interaction voids.
    calculateRange();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      resizeObserver?.disconnect();
      if (rafIdRef.current !== null && rafIdRef.current !== RAF_SCHEDULED_SENTINEL) {
        cancelAnimationFrame(rafIdRef.current);
      }
      rafIdRef.current = null;
    };
  }, [calculateRange, scheduleRangeCalculation]);

  // Recalculate on configuration changes while preserving RAF batching.
  useEffect(() => {
    scheduleRangeCalculation();
  }, [itemCount, rowHeight, overscan, scheduleRangeCalculation]);

  const totalHeight = itemCount * rowHeight;

  return { containerRef, range, offset, totalHeight };
}
