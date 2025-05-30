import { useEffect, useRef, useState } from 'react';

export interface VirtualRange {
  start: number;
  end: number;
}

export interface UseVirtualListReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  range: VirtualRange;
  offset: number;
  totalHeight: number;
}

export function useVirtualList(itemCount: number, rowHeight: number): UseVirtualListReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0 });
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const scrollTop = container.scrollTop;
      const clientHeight = container.clientHeight;
      const start = Math.floor(scrollTop / rowHeight);
      const end = Math.min(itemCount - 1, Math.floor((scrollTop + clientHeight) / rowHeight));
      setRange({ start, end });
      setOffset(start * rowHeight);
    };

    handleScroll();
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [itemCount, rowHeight]);

  const totalHeight = itemCount * rowHeight;

  return { containerRef, range, offset, totalHeight };
}
