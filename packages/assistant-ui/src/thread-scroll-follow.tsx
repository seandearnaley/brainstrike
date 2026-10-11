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
 * - Pointer, wheel, and touch intent cancel both an in-flight follow and any
 *   scheduled post-layout measurement so user navigation wins immediately.
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
  /** Explicit message navigation disengages follow without notifying re-pin callers. */
  readonly scrollToMessage: (target: HTMLElement) => void;
  /** Subscribe to pinned-state changes (for `useSyncExternalStore`). */
  readonly subscribe: (listener: () => void) => () => void;
}

function createThreadScrollFollow(): ThreadScrollFollow {
  let element: HTMLElement | null = null;
  let isAtBottom = true;
  /** True while a follow/explicit scroll is in flight and may still settle. */
  let pendingFollow = false;
  let lastScrollTop = 0;
  let hidden = false;
  let lastScrollHeight = 0;
  let lastObservedScrollHeight = 0;
  let lastObservedClientHeight = 0;
  /**
   * The `scrollTop` already judged by `measure` after its write or an observed
   * native bottom clamp, awaiting its `scroll` event. Claimed only in `measure`;
   * consumed only in `onScroll`. Ordinary no-op writes leave no claim.
   */
  let unechoedWriteTop: number | null = null;
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
   * Parity port of the library's scroll bookkeeping. A measured native clamp
   * or follow write can echo after a later resize. Its already-judged event is
   * consumed in `onScroll` before it can misclassify that new geometry as reader
   * intent. `lastScrollTop` is the last position PROCESSED here, not necessarily
   * the position immediately before an event: native events may coalesce.
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
    // Hidden workspace tabs report zero geometry. That is not a reader at
    // the bottom; retain the visible tab's pinnedness until layout returns.
    if (clientHeight === 0) {
      hidden = true;
      unechoedWriteTop = null;
      return;
    }
    const resuming = hidden;
    hidden = false;
    const restoringReader = resuming && !isAtBottom && !pendingFollow;
    const topBefore = el.scrollTop;
    if (restoringReader) {
      // Browser anchoring can displace a kept-alive viewport while hidden.
      // Restore the last observed reading position before judging new geometry.
      el.scrollTo({ behavior: 'instant', top: lastScrollTop });
    }
    if (
      !resuming &&
      scrollHeight === lastObservedScrollHeight &&
      clientHeight === lastObservedClientHeight
    ) {
      return;
    }
    lastObservedScrollHeight = scrollHeight;
    lastObservedClientHeight = clientHeight;
    // M3 delegated-command failure: Chromium clamped to the new bottom before
    // measure, so our follow write was a no-op but its native event was pending.
    const observedBottomClamp =
      isAtBottom &&
      lastScrollTop > scrollHeight - clientHeight + 1 &&
      Math.abs(scrollHeight - clientHeight - topBefore) <= 1;
    if (pendingFollow) {
      // Complete an in-flight follow/explicit scroll through the resize.
      write(el);
    } else if (isAtBottom) {
      // Pinned growth follow: instant on purpose — CSS smooth would lag
      // per-token streaming growth.
      write(el, 'instant');
    }
    if (restoringReader) {
      // A clamp after hidden content shrank is not a user's request to follow.
      lastScrollTop = el.scrollTop;
      lastScrollHeight = el.scrollHeight;
    } else {
      handleScroll(el);
    }
    // The claim is made HERE, and only here, because the justification for
    // swallowing an echo is the synchronous `handleScroll` immediately above —
    // this is the one path that judges its own write in the same breath. The
    // explicit-request writes (`scrollToBottom`, `jumpToBottomInstant`) do not
    // judge, so their echo is the ONLY thing that can re-pin the thread and
    // must never be swallowed; keeping the claim out of `write` makes that
    // structural rather than a rule someone has to remember.
    //
    // Claim a moving write or a native bottom clamp this measure already judged.
    // Ordinary no-op writes produce no event and must leave no lingering claim.
    // A CSS smooth write has not moved yet; pendingFollow guards its animation.
    unechoedWriteTop = el.scrollTop !== topBefore || observedBottomClamp ? el.scrollTop : null;
  };

  return {
    attach: (el) => {
      element = el;
      hidden = el.clientHeight === 0;
      lastScrollTop = el.scrollTop;
      lastScrollHeight = el.scrollHeight;
      lastObservedScrollHeight = el.scrollHeight;
      lastObservedClientHeight = el.clientHeight;
      // A claim belongs to the element that was written; the previous
      // scroller's echo must never be matched against this one's position.
      unechoedWriteTop = null;
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
      /**
       * A `scroll` event carries no position of its own — `handleScroll` reads
       * LIVE geometry — so an event is only evidence about the state it is
       * judged against. `measure` writes `scrollTop` synchronously and judges
       * the result in the same breath (clearing `pendingFollow`), while the
       * browser dispatches that write's event a task LATER. If the viewport is
       * resized in between, that leftover event is judged against dimensions
       * the engine has never measured: "not at bottom, and the position did not
       * move down" — indistinguishable from a reader parked above the end. That
       * unpinned follow with no user act, permanently, since `measure` only
       * re-sticks while pinned (BST-1039: the queue's chip row shrinks the
       * viewport from OUTSIDE the scroller while a streamed chunk grows the
       * content inside it, and neither fires a scroll event of its own).
       *
       * So a `measure` write CLAIMS the position it moved to and the echo is
       * swallowed once: the synchronous judgement there already covered it, and
       * `measure` is what will re-stick through the resize. See the claim site
       * for why it lives in `measure` and not in `write`.
       *
       * A claim requires a moving write or a measured native bottom clamp,
       * NOT merely an unchanged scrollTop. User events coalesce too: a round
       * trip can have zero net movement and must still disengage. User intent
       * clears the claim before such an event is delivered.
       */
      const onScroll = () => {
        if (el.clientHeight === 0) {
          hidden = true;
          unechoedWriteTop = null;
          return;
        }
        if (hidden) {
          measure(el);
          return;
        }
        const isOwnWriteEcho = unechoedWriteTop === el.scrollTop;
        unechoedWriteTop = null;
        if (isOwnWriteEcho) {
          lastScrollTop = el.scrollTop;
          lastScrollHeight = el.scrollHeight;
          return;
        }
        handleScroll(el);
      };
      const onUserIntent = () => {
        pendingFollow = false;
        unechoedWriteTop = null;
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
    scrollToMessage: (target) => {
      if (!element?.contains(target)) {
        throw new Error('The requested message is outside this conversation viewport.');
      }
      pendingFollow = false;
      unechoedWriteTop = null;
      setIsAtBottom(false);
      element.scrollTo({
        behavior: 'instant',
        top:
          element.scrollTop +
          target.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          Math.max(0, (element.clientHeight - target.clientHeight) / 2),
      });
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
