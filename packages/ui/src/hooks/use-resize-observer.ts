import { useEffect, useRef } from 'react';

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
 * Observation starts once `elementRef.current` points to an element. This supports
 * refs that are `null` on the first render (for example, conditionally rendered targets).
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

  useEffect(() => {
    if (disabled) {
      return;
    }

    let resizeRafId: ReturnType<typeof requestAnimationFrame> | null = null;
    let attachPollRafId: ReturnType<typeof requestAnimationFrame> | null = null;
    let attachPollCount = 0;
    let resizeObserver: ResizeObserver | null = null;
    const MaxAttachPollAttempts = 120;

    const attachResizeObserver = (element: T): void => {
      if (resizeObserver) {
        return;
      }

      resizeObserver = new ResizeObserver((entries) => {
        // Cancel any pending animation frame to batch rapid resize events
        if (resizeRafId !== null) {
          cancelAnimationFrame(resizeRafId);
        }

        // Schedule the callback for the next animation frame
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = null;
          // Only process the last entry since we're observing a single element
          const entry = entries.at(-1);
          if (entry) {
            callbackRef.current(entry);
          }
        });
      });

      resizeObserver.observe(element);
    };

    const tryAttachObserver = (): void => {
      const element = elementRef.current;
      if (element) {
        attachResizeObserver(element);
        return;
      }
      if (attachPollCount >= MaxAttachPollAttempts) {
        return;
      }
      attachPollCount += 1;
      // Keep checking until the ref is populated, then attach once.
      attachPollRafId = requestAnimationFrame(tryAttachObserver);
    };

    tryAttachObserver();

    return () => {
      // Cancel any pending attachment-polling animation frame
      if (attachPollRafId !== null) {
        cancelAnimationFrame(attachPollRafId);
      }

      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId);
      }

      resizeObserver?.disconnect();
    };
  }, [elementRef, disabled]);
}
