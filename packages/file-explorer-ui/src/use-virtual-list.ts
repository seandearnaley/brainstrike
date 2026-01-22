import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

export interface VirtualRange {
  start: number;
  end: number;
}

export interface UseVirtualListOptions {
  /** Number of rows to render above/below visible area (default: 5) */
  overscan?: number;
}

export interface UseVirtualListReturn {
  containerRef: RefObject<HTMLDivElement | null>;
  range: VirtualRange;
  offset: number;
  totalHeight: number;
}

/**
 * Virtual list hook for efficiently rendering large lists.
 *
 * Performance optimizations:
 * - Uses requestAnimationFrame to batch scroll updates
 * - Default overscan of 5 rows provides buffer for smooth scrolling
 * - Avoids unnecessary re-renders by comparing previous range values
 * - Uses useEffect instead of useLayoutEffect to avoid blocking the browser
 *   during heavy state updates (e.g., select all with 1000+ files)
 */
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

  // Track pending RAF to avoid duplicate frames
  const rafIdRef = useRef<number | null>(null);
  // Track previous values to avoid unnecessary state updates
  const prevRangeRef = useRef<VirtualRange>({ start: 0, end: 0 });
  const prevOffsetRef = useRef(0);

  // NOTE: Using useEffect instead of useLayoutEffect is intentional.
  // useLayoutEffect runs synchronously after DOM mutations, which forces
  // the browser to recalculate layout when reading scrollTop/clientHeight.
  // During rapid state updates (like selecting 1000+ files), this causes
  // layout thrashing. useEffect defers these reads to after paint, allowing
  // the browser to batch layout calculations.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const calculateRange = () => {
      const scrollTop = container.scrollTop;
      const clientHeight = container.clientHeight;
      const baseStart = Math.floor(scrollTop / rowHeight);
      const baseEnd = Math.floor((scrollTop + clientHeight) / rowHeight);
      const start = Math.max(0, baseStart - overscan);
      const end = Math.min(itemCount - 1, baseEnd + overscan);
      const newOffset = baseStart * rowHeight;

      // Only update state if values have changed
      const rangeChanged = start !== prevRangeRef.current.start || end !== prevRangeRef.current.end;
      const offsetChanged = newOffset !== prevOffsetRef.current;

      if (rangeChanged || offsetChanged) {
        if (rangeChanged) {
          prevRangeRef.current = { start, end };
          setRange({ start, end });
        }
        if (offsetChanged) {
          prevOffsetRef.current = newOffset;
          setOffset(newOffset);
        }
      }

      rafIdRef.current = null;
    };

    const handleScroll = () => {
      // Use RAF to batch scroll updates and avoid layout thrashing
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(calculateRange);
      }
    };

    // Initial calculation (no RAF needed for first render)
    calculateRange();

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [itemCount, rowHeight, overscan]);

  const totalHeight = itemCount * rowHeight;

  return { containerRef, range, offset, totalHeight };
}
