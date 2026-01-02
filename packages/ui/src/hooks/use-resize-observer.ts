import { useEffect, useRef } from 'react';

/**
 * A hook that provides a ResizeObserver with requestAnimationFrame debouncing
 * to prevent "ResizeObserver loop completed with undelivered notifications" errors.
 *
 * This error occurs when a resize callback triggers a layout change that causes
 * another resize observation before the current animation frame completes.
 * By batching updates with requestAnimationFrame, we ensure all resize handling
 * happens within a single frame, preventing the loop detection from triggering.
 *
 * @param elementRef - React ref to the element to observe
 * @param onResize - Callback fired with the latest resize entry (debounced via RAF)
 *
 * @example
 * ```tsx
 * const containerRef = useRef<HTMLDivElement>(null);
 * const [height, setHeight] = useState(0);
 *
 * useResizeObserver(containerRef, (entry) => {
 *   setHeight(entry.contentRect.height);
 * });
 * ```
 */
export function useResizeObserver<T extends Element>(
  elementRef: React.RefObject<T | null>,
  onResize: (entry: ResizeObserverEntry) => void
): void {
  // Store the latest callback in a ref to avoid recreating the observer
  const callbackRef = useRef(onResize);
  callbackRef.current = onResize;

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    let rafId: ReturnType<typeof requestAnimationFrame> | null = null;

    const observer = new ResizeObserver((entries) => {
      // Cancel any pending animation frame to batch rapid resize events
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      // Schedule the callback for the next animation frame
      rafId = requestAnimationFrame(() => {
        rafId = null;
        // Only process the last entry since we're observing a single element
        const entry = entries.at(-1);
        if (entry) {
          callbackRef.current(entry);
        }
      });
    });

    observer.observe(element);

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      observer.disconnect();
    };
  }, [elementRef]);
}
