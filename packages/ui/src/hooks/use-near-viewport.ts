import { type RefObject, useEffect, useState } from 'react';

/**
 * Room around the visible area in which work starts ahead of being scrolled
 * to. A thread keeps every turn mounted, and doing every turn's work at once
 * blocked opening a long thread (BST-2314).
 */
const AHEAD_MARGIN = '1200px 0px';

/** Whether the element has come within {@link AHEAD_MARGIN} of view; it never turns back. */
export function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (near || !element) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      // `scrollMargin` extends the margin into the thread's own scroller, which
      // clips intersections before `rootMargin` applies.
      { rootMargin: AHEAD_MARGIN, scrollMargin: AHEAD_MARGIN }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}
