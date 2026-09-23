import { useResizeObserver } from '@brainstrike/ui';
import { type RefObject, useCallback, useState } from 'react';

/**
 * Width the scroller's vertical scrollbar takes from its content box: 0 with
 * overlay scrollbars, about 15px with classic ones. The column header sits
 * OUTSIDE the scroller and pads by this so its columns align with the rows.
 * Mirrors the Explorer forest header's private measurement
 * (file-explorer-ui/src/shell/explorer-column-header.tsx).
 */
export function useScrollbarGutterWidth(scrollerRef: RefObject<HTMLElement | null>): number {
  const [gutterWidth, setGutterWidth] = useState(0);
  useResizeObserver(
    scrollerRef,
    useCallback(() => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        return;
      }
      const next = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      setGutterWidth((previous) => (Math.abs(previous - next) < 1 ? previous : next));
    }, [scrollerRef])
  );
  return gutterWidth;
}
