import { useCallback, useEffect, useRef } from 'react';

/**
 * Options for the useResizeObserver hook.
 */
export interface UseResizeObserverOptions {
  /**
   * When true, the observer is disabled and will not observe the element.
   * Useful for conditional observation without unmounting/remounting.
   * @default false
   */
  disabled?: boolean;
}

/**
 * A hook that provides a ResizeObserver with requestAnimationFrame debouncing
 * to prevent "ResizeObserver loop completed with undelivered notifications" errors.
 *
 * This error occurs when a resize callback triggers a layout change that causes
 * another resize observation before the current animation frame completes.
 * By batching updates with requestAnimationFrame, we ensure all resize handling
 * happens within a single frame, preventing the loop detection from triggering.
 *
 * @performance Only the last resize entry per frame is processed, ensuring 60fps
 * even with rapid resize events (e.g., during window drag operations).
 *
 * @param elementRef - React ref to the element to observe
 * @param onResize - Callback fired with the latest resize entry (debounced via RAF)
 * @param options - Optional configuration for the observer
 *
 * @remarks
 * Observation starts after a render where `elementRef.current` points to an element.
 * This supports refs that are `null` on the first render, then populated by a later
 * React render (for example, conditionally rendered targets). Mutating
 * `elementRef.current` outside React without causing a render will not notify the hook.
 *
 * @example
 * ```tsx
 * const containerRef = useRef<HTMLDivElement>(null);
 * const [height, setHeight] = useState(0);
 *
 * useResizeObserver(containerRef, (entry) => {
 *   setHeight(entry.contentRect.height);
 * });
 *
 * // With disabled option (conditional observation)
 * useResizeObserver(containerRef, handleResize, { disabled: !shouldObserve });
 * ```
 */
export function useResizeObserver<T extends Element>(
  elementRef: React.RefObject<T | null>,
  onResize: (entry: ResizeObserverEntry) => void,
  options?: UseResizeObserverOptions
): void {
  const { disabled = false } = options ?? {};
  // Store the latest callback in a ref to avoid recreating the observer
  const callbackRef = useRef(onResize);
  callbackRef.current = onResize;
  const resizeRafIdRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedElementRef = useRef<T | null>(null);

  const disconnectObserver = useCallback((): void => {
    if (resizeRafIdRef.current !== null) {
      cancelAnimationFrame(resizeRafIdRef.current);
      resizeRafIdRef.current = null;
    }

    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    observedElementRef.current = null;
  }, []);

  // Intentionally run after every committed render so changes to elementRef.current
  // are observed even when the ref object identity is stable.
  useEffect(() => {
    if (disabled) {
      disconnectObserver();
      return;
    }

    const element = elementRef.current;
    if (element === observedElementRef.current) {
      return;
    }

    disconnectObserver();

    if (!element) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      // Cancel any pending animation frame to batch rapid resize events
      if (resizeRafIdRef.current !== null) {
        cancelAnimationFrame(resizeRafIdRef.current);
      }

      // Schedule the callback for the next animation frame
      resizeRafIdRef.current = requestAnimationFrame(() => {
        resizeRafIdRef.current = null;
        // Only process the last entry since we're observing a single element
        const entry = entries.at(-1);
        if (entry) {
          callbackRef.current(entry);
        }
      });
    });

    resizeObserver.observe(element);
    resizeObserverRef.current = resizeObserver;
    observedElementRef.current = element;
  });

  useEffect(() => disconnectObserver, [disconnectObserver]);
}
