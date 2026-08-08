/**
 * REPO-OWNED stick-to-bottom for the STATIC thread tier (BST-896/BST-1039).
 *
 * Until the 0.15 upgrade this behaviour came from @assistant-ui's
 * `ThreadPrimitive.Viewport` + `useThreadViewportAutoScroll`. That hook broke
 * twice upstream (0.14.28 and 0.15.x both re-create its ResizeObserver on
 * every `isRunning` flip, silently unpinning follow on every send — see
 * docs/dependency-updates-breaking-changes.md), and the failure is not
 * workable at the library's public API: the scrollTop clamp misread is
 * indistinguishable from a real user scroll from the outside. So tier 1 now
 * owns the whole mechanism, exactly as tier 2 already owns scrolling through
 * its virtualizer.
 *
 * The ALGORITHM is a deliberate parity port of the library's (it is proven by
 * the BST-1039 + jump-button browser suites); what differs is the LIFECYCLE:
 * one engine instance with observers attached exactly once per scroller
 * element, never torn down by React re-renders — the stable lifecycle IS the
 * fix.
 *
 * Semantics preserved (see docs/agents/assistant-runtime.md THREAD SCROLLING):
 * - Pinned at the bottom → streaming growth re-sticks (`behavior: 'instant'`,
 *   deliberately bypassing CSS smooth for per-token growth).
 * - The user scrolling UP disengages follow; streaming never steals the
 *   reading position back. Re-engaging is an explicit act.
 * - Explicit `scrollToBottom()` (jump button, BST-1039 dispatch re-pin) passes
 *   NO scroll behavior: `scrollTo`'s default `'auto'` routes through CSS
 *   `scroll-behavior`, so the global `prefers-reduced-motion` override in
 *   globals.css keeps applying.
 * - `pointerdown` cancels an in-flight follow so a user grabbing the
 *   scrollbar mid-scroll wins immediately.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';

export interface ThreadScrollFollow {
  /**
   * Attach the engine to the tier-1 scroller. Returns the detach cleanup.
   * One element at a time; attaching re-seeds the scroll bookkeeping.
   */
  readonly attach: (element: HTMLElement) => () => void;
  /** Current pinned state (true ⇒ follow is engaged). */
  readonly getIsAtBottom: () => boolean;
  /**
   * Thread-switch jump: instant, no request-listener notification (parity
   * with the library's `scrollToBottomOnThreadSwitch`, which never routed
   * through the outer store's request event).
   */
  readonly jumpToBottomInstant: () => void;
  /**
   * Observation seam for explicit requests — the BST-1039 test asserts the
   * dispatch re-pin THROUGH this, as behaviour rather than implementation.
   */
  readonly onScrollToBottom: (listener: () => void) => () => void;
  /**
   * Explicit request: notify observers, then pin + scroll. The scroll passes
   * no behavior so CSS `scroll-behavior` (and the reduced-motion override)
   * decides the motion.
   */
  readonly scrollToBottom: () => void;
  /** Subscribe to pinned-state changes (for `useSyncExternalStore`). */
  readonly subscribe: (listener: () => void) => () => void;
}

function createThreadScrollFollow(): ThreadScrollFollow {
  let element: HTMLElement | null = null;
  let isAtBottom = true;
  /** True while a follow/explicit scroll is in flight and may still settle. */
  let pendingFollow = false;
  let lastScrollTop = 0;
  let lastScrollHeight = 0;
  let lastObservedScrollHeight = 0;
  let lastObservedClientHeight = 0;
  const stateListeners = new Set<() => void>();
  const requestListeners = new Set<() => void>();

  const setIsAtBottom = (next: boolean): void => {
    if (isAtBottom === next) {
      return;
    }
    isAtBottom = next;
    for (const listener of stateListeners) {
      listener();
    }
  };

  const write = (el: HTMLElement, behavior?: ScrollBehavior): void => {
    pendingFollow = true;
    if (behavior) {
      el.scrollTo({ behavior, top: el.scrollHeight });
    } else {
      el.scrollTo({ top: el.scrollHeight });
    }
  };

  /**
   * Parity port of the library's scroll bookkeeping. The one misread this
   * inherits — a scrollHeight clamp arriving with no in-flight follow reads
   * as a user scroll — is unreachable in practice because `measure` below
   * re-sticks (arming `pendingFollow`) from a LIVE observer before the
   * clamp's scroll event is dispatched; the upstream bug was precisely that
   * its observer was being reconstructed at that moment and missed the
   * window.
   */
  const handleScroll = (el: HTMLElement): void => {
    const nextAtBottom =
      Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= 1 ||
      el.scrollHeight <= el.clientHeight;
    if (nextAtBottom || lastScrollTop >= el.scrollTop) {
      if (nextAtBottom) {
        if (el.scrollHeight > el.clientHeight + 1) {
          pendingFollow = false;
        }
      } else if (lastScrollTop > el.scrollTop && lastScrollHeight === el.scrollHeight) {
        // A true upward user scroll: same content, smaller scrollTop.
        pendingFollow = false;
      }
      if ((nextAtBottom || !pendingFollow) && nextAtBottom !== isAtBottom) {
        setIsAtBottom(nextAtBottom);
      }
    }
    lastScrollTop = el.scrollTop;
    lastScrollHeight = el.scrollHeight;
  };

  const measure = (el: HTMLElement): void => {
    const { scrollHeight, clientHeight } = el;
    if (scrollHeight === lastObservedScrollHeight && clientHeight === lastObservedClientHeight) {
      return;
    }
    lastObservedScrollHeight = scrollHeight;
    lastObservedClientHeight = clientHeight;
    if (pendingFollow) {
      // Complete an in-flight follow/explicit scroll through the resize.
      write(el);
    } else if (isAtBottom) {
      // Pinned growth follow: instant on purpose — CSS smooth would lag
      // per-token streaming growth.
      write(el, 'instant');
    }
    handleScroll(el);
  };

  return {
    attach: (el) => {
      element = el;
      lastScrollTop = el.scrollTop;
      lastScrollHeight = el.scrollHeight;
      lastObservedScrollHeight = el.scrollHeight;
      lastObservedClientHeight = el.clientHeight;
      let measurementFrame: number | null = null;
      const cancelScheduledMeasurement = (): void => {
        if (measurementFrame === null) {
          return;
        }
        cancelAnimationFrame(measurementFrame);
        measurementFrame = null;
      };
      const scheduleMeasurement = (): void => {
        if (measurementFrame !== null) {
          return;
        }
        measurementFrame = requestAnimationFrame(() => {
          measurementFrame = null;
          measure(el);
        });
      };
      const onScroll = () => handleScroll(el);
      const onUserIntent = () => {
        pendingFollow = false;
        cancelScheduledMeasurement();
      };
      const resizeObserver = new ResizeObserver(() => measure(el));
      // The mutation observer is what sees CONTENT growth (scrollHeight is
      // invisible to a ResizeObserver on the scroller itself). Style-only
      // attribute mutations are ignored, matching the library: growth must
      // arrive the way streaming text does. Mutation delivery can precede
      // final layout, so every immediate measurement is followed by one
      // animation-frame verification. The frame also coalesces a burst of
      // streamed character-data records into one post-layout read.
      const mutationObserver = new MutationObserver((mutations) => {
        if (mutations.some((m) => m.type !== 'attributes' || m.attributeName !== 'style')) {
          measure(el);
          scheduleMeasurement();
        }
      });
      resizeObserver.observe(el);
      mutationObserver.observe(el, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      el.addEventListener('scroll', onScroll);
      el.addEventListener('pointerdown', onUserIntent);
      el.addEventListener('touchstart', onUserIntent, { passive: true });
      el.addEventListener('wheel', onUserIntent, { passive: true });
      return () => {
        cancelScheduledMeasurement();
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        el.removeEventListener('scroll', onScroll);
        el.removeEventListener('pointerdown', onUserIntent);
        el.removeEventListener('touchstart', onUserIntent);
        el.removeEventListener('wheel', onUserIntent);
        if (element === el) {
          element = null;
        }
      };
    },
    getIsAtBottom: () => isAtBottom,
    jumpToBottomInstant: () => {
      if (element) {
        write(element, 'instant');
      }
    },
    onScrollToBottom: (listener) => {
      requestListeners.add(listener);
      return () => {
        requestListeners.delete(listener);
      };
    },
    scrollToBottom: () => {
      for (const listener of requestListeners) {
        listener();
      }
      if (element) {
        write(element);
      }
    },
    subscribe: (listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
}

const ThreadScrollFollowContext = createContext<ThreadScrollFollow | null>(null);

/**
 * Owns one follow engine per assistant panel. Must wrap BOTH the thread
 * region (scroller + jump button) and every explicit-scroll caller (the
 * follow-up queue bridge's BST-1039 re-pin).
 */
export const ThreadScrollFollowProvider = ({ children }: { children: ReactNode }) => {
  const [follow] = useState(createThreadScrollFollow);
  return (
    <ThreadScrollFollowContext.Provider value={follow}>
      {children}
    </ThreadScrollFollowContext.Provider>
  );
};

/** The panel's follow engine. Throws outside the provider — never a stub. */
export function useThreadScrollFollow(): ThreadScrollFollow {
  const follow = useContext(ThreadScrollFollowContext);
  if (!follow) {
    throw new Error('useThreadScrollFollow requires a ThreadScrollFollowProvider ancestor.');
  }
  return follow;
}

/**
 * Callback ref that attaches the follow engine to a scroller element, with
 * the engine's stable-lifecycle guarantee (identity changes only with the
 * provider's engine instance). Shared by the tier-1 region and the browser
 * test harnesses so both exercise the same real wiring.
 */
export function useThreadFollowScrollerRef(): (
  element: HTMLDivElement | null
) => (() => void) | undefined {
  const follow = useThreadScrollFollow();
  return useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        return;
      }
      return follow.attach(element);
    },
    [follow]
  );
}

/** Reactive pinned state for the region's data-pinned + the jump button. */
export function useThreadFollowIsAtBottom(): boolean {
  const follow = useThreadScrollFollow();
  return useSyncExternalStore(follow.subscribe, follow.getIsAtBottom, follow.getIsAtBottom);
}
