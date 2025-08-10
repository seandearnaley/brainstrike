import type { RefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

export interface VirtualRange {
  start: number;
  end: number;
}

export interface UseVirtualListOptions {
  overscan?: number;
}

export interface UseVirtualListReturn {
  containerRef: RefObject<HTMLDivElement | null>;
  range: VirtualRange;
  offset: number;
  totalHeight: number;
}

export function useVirtualList(
  itemCount: number,
  rowHeight: number,
  options: UseVirtualListOptions = {}
): UseVirtualListReturn {
  const { overscan = 0 } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0 });
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const computeRange = () => {
      const scrollTop = container.scrollTop;
      const clientHeight = container.clientHeight;
      const baseStart = Math.floor(scrollTop / rowHeight);
      const baseEnd = Math.floor((scrollTop + clientHeight) / rowHeight);
      const start = Math.max(0, baseStart - overscan);
      const end = Math.min(itemCount - 1, baseEnd + overscan);
      setRange({ start, end });
      setOffset(baseStart * rowHeight);
    };

    const handleScroll = () => {
      computeRange();
    };

    // Recompute on resize (panel show/hide, container size changes)
    const ro = new ResizeObserver(() => {
      computeRange();
    });
    ro.observe(container);

    handleScroll();
    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      ro.disconnect();
    };
  }, [itemCount, rowHeight, overscan]);

  const totalHeight = itemCount * rowHeight;

  return { containerRef, range, offset, totalHeight };
}
