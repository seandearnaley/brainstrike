import {
  ThreadPrimitive,
  // Aliased to a `use`-prefixed name for the same Fast Refresh reason as the
  // panel's slash-command adapter: Vite's Fast Refresh builds a component's
  // hook signature by matching `use…` call sites, and a bare `unstable_use…`
  // call is missed — the component then crashes with "Rendered fewer hooks".
  // See __tests__/fast-refresh-hook-aliasing.test.ts.
  unstable_useThreadMessageIds as useThreadMessageIds,
} from '@assistant-ui/react';
import { observeElementOffset, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { ArrowDownIcon } from 'lucide-react';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AssistantThreadStateProvider } from './assistant-thread-state-context';
import { useThreadFollowIsAtBottom, useThreadScrollFollow } from './thread-scroll-follow';

/**
 * TWO-TIER THREAD RENDERER (BST-897)
 *
 * Threads must stay responsive as they grow without bound, and the two tiers
 * make different trade-offs:
 *
 * TIER 1 — "static" (every thread below THREAD_VIRTUALIZATION_THRESHOLD).
 *   Every message is a real DOM row rendered by `ThreadPrimitive.Messages`.
 *   Off-screen rows are skipped by the browser via `content-visibility: auto`
 *   (see overrides.css), which keeps find-in-page, text selection, screen
 *   readers and anchor links working — the reason this is the DEFAULT tier.
 *   The REPO owns scrolling here (thread-scroll-follow.tsx): the follow
 *   engine sticks to streaming growth while pinned and disengages the moment
 *   the user scrolls up (BST-896). The library's viewport auto-scroll is
 *   deliberately out of the loop — it broke twice upstream (0.14.28, 0.15.x).
 *
 * TIER 2 — "virtual" (at or above the threshold).
 *   The message list becomes an end-anchored TanStack virtualizer, so the
 *   mounted row count is bounded by the viewport instead of the thread length.
 *   The virtualizer becomes the SINGLE scroll owner: the library's autoScroll
 *   is switched off (two owners writing scrollTop fight each other), and the
 *   jump-to-latest button is driven by `isAtEnd()` / `scrollToEnd()` instead of
 *   the library's viewport store.
 *
 * The active tier is published as `data-thread-render-tier` on the viewport —
 * tier selection is observable, never silent.
 *
 * MESSAGE COMPONENTS ARE SHARED: both tiers receive the same `components` map
 * and render it through library primitives (`ThreadPrimitive.Messages` /
 * `ThreadPrimitive.Unstable_MessageById`), so AssistantMessage / UserMessage /
 * EditComposer markup is never forked per tier.
 */

/**
 * Message count at which the renderer switches to virtualization.
 *
 * Deliberately well above a normal working thread: tier 1 keeps the browser's
 * native text affordances, so we only give them up once the row count is the
 * dominant cost. Exported so tests and callers share one number.
 */
export const THREAD_VIRTUALIZATION_THRESHOLD = 400;

/**
 * Height assumed for a not-yet-measured message row. Matches the
 * `contain-intrinsic-size` estimate used by tier 1 in overrides.css; a CDT
 * sweep measured a one-line user message at ~73px, and multi-line assistant
 * turns run considerably taller, so this errs slightly high to keep the
 * estimated scroll range from collapsing under the real one.
 */
export const THREAD_MESSAGE_ESTIMATED_HEIGHT_PX = 120;

/**
 * How close to the end still counts as "pinned". Wider than the library's
 * 1px default so sub-pixel layout does not silently disengage auto-follow.
 * Exported so the browser contract can prove its scrolled-up setup is outside
 * the same end-anchor window without duplicating this value.
 */
export const THREAD_END_THRESHOLD_PX = 24;

/** Rows kept mounted beyond the visible range on each side. */
const THREAD_VIRTUAL_OVERSCAN = 6;

export type ThreadRenderTier = 'static' | 'virtual';

/**
 * The library's message-component map. Taken from the primitive itself so the
 * panel's map is type-checked against exactly what both tiers render.
 */
export type ThreadMessageComponents = ComponentProps<
  typeof ThreadPrimitive.Unstable_MessageById
>['components'];

/**
 * Chrome shared by both tiers' jump-to-latest button. Only the BEHAVIOUR
 * differs (library viewport store vs. virtualizer); the class, icon, label and
 * test id are defined once.
 */
const JUMP_TO_LATEST_PROPS = {
  'aria-label': 'Scroll to latest messages',
  className: 'bs-scroll-to-bottom',
  'data-testid': 'assistant-scroll-to-bottom',
} as const;

/**
 * Reduced motion for the TIER-2 jump.
 *
 * Tier 1 deliberately passes NO `behavior` so the scroll routes through CSS
 * `scroll-behavior`, which globals.css already forces to `auto` under reduced
 * motion. Tier 2 cannot do that: the virtualizer's behavior argument is not
 * just forwarded to `scrollTo`, it drives the instance's scroll state machine
 * (a `'smooth'` scroll suppresses measurement corrections so re-measuring items
 * cannot push the target away mid-animation). So the option must be explicit —
 * which bypasses the CSS override — and the preference is honoured here.
 */
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Positioning context for the scroller + its floating affordance, and the one
 * place that publishes the viewport's pinned state to CSS (BST-896).
 *
 * `data-pinned` mirrors the viewport store's `isAtBottom`, which is what scopes
 * `overflow-anchor: none` in overrides.css: JS only writes scrollTop while the
 * thread is pinned, so native scroll anchoring must stay ON everywhere else —
 * it is the only thing holding the reading position still when content ABOVE
 * the viewport resizes (markdown/Shiki resolving, images loading, tool cards
 * folding). Reading it here rather than in ChatThreadUI keeps the pin
 * transition from re-rendering the whole thread subtree.
 *
 * That scoping is the STATIC tier's contract. On the virtualized tier the
 * virtualizer corrects scrollTop in every state, so overrides.css opts out of
 * native anchoring unconditionally there — see the `data-thread-render-tier`
 * rule, which is independent of this attribute.
 */
export const ThreadScrollRegion = ({ children }: { children: ReactNode }) => {
  const isAtBottom = useThreadFollowIsAtBottom();

  return (
    <div className="bs-thread-scroll-region" data-pinned={isAtBottom ? 'true' : undefined}>
      {children}
    </div>
  );
};

/**
 * Tier-2 signals for the jump-to-latest button. Plain values rather than the
 * virtualizer instance: the instance's identity never changes, so a child
 * memoized on it would freeze — the button has to re-render as the scroll
 * position crosses the end threshold.
 */
export interface ThreadVirtualScrollSignals {
  /** Whether the thread currently sits at the newest message. */
  readonly atEnd: boolean;
  /** Drives the virtualizer back to the newest message. */
  readonly jumpToEnd: () => void;
}

/**
 * Floating "jump to latest" affordance (BST-896, re-homed by BST-897).
 *
 * Without a virtualizer the behaviour comes from the repo's follow engine
 * (thread-scroll-follow.tsx): DISABLED while the thread is pinned at the
 * bottom (overrides.css then fades it out), otherwise it scrolls to the
 * latest message — which re-engages follow. Passing `virtualScroll` selects
 * the tier-2 behaviour instead; all three render identical chrome.
 *
 * NO explicit `behavior` on the tier-1 jump: an explicit option would bypass
 * CSS `scroll-behavior` and therefore also bypass the global
 * `prefers-reduced-motion` override in globals.css — the engine's
 * `scrollToBottom()` deliberately omits it. Tier 2 is the documented
 * exception (see prefersReducedMotion).
 *
 * MOUNT SITE matters: it renders inside `.bs-thread-scroll-region` as a SIBLING
 * of the scroller, never inside it, so it stays anchored above the composer
 * instead of scrolling away with the messages. That works outside the scroller
 * element because the follow engine lives in ThreadScrollFollowProvider
 * context above both.
 */
export const ThreadScrollToBottom = ({
  virtualScroll,
}: {
  virtualScroll?: ThreadVirtualScrollSignals | null | undefined;
}) => {
  if (virtualScroll) {
    return (
      <button
        disabled={virtualScroll.atEnd}
        onClick={virtualScroll.jumpToEnd}
        type="button"
        {...JUMP_TO_LATEST_PROPS}
      >
        <ArrowDownIcon aria-hidden="true" />
      </button>
    );
  }

  return <ThreadStaticScrollToBottom />;
};

/**
 * Tier-1 jump button on the repo-owned follow engine: DISABLED while pinned
 * (overrides.css fades it out), otherwise scrolls to the latest message and
 * re-engages follow — the same contract the library primitive used to
 * provide, now against `thread-scroll-follow.tsx`.
 */
const ThreadStaticScrollToBottom = () => {
  const follow = useThreadScrollFollow();
  const isAtBottom = useThreadFollowIsAtBottom();
  return (
    <button
      disabled={isAtBottom}
      onClick={() => follow.scrollToBottom()}
      type="button"
      {...JUMP_TO_LATEST_PROPS}
    >
      <ArrowDownIcon aria-hidden="true" />
    </button>
  );
};

export interface ThreadMessagesRegionProps {
  /** Message components shared verbatim by both tiers. */
  readonly components: ThreadMessageComponents;
  /** Optional notice rendered above the messages (e.g. "assistant disabled"). */
  readonly disabledReason?: ReactNode;
  /** Identity of the open thread; switching it re-arms the tier-2 end anchor. */
  readonly threadKey?: string | undefined;
}

/**
 * The thread's scroll region: the scroller, the message list for the active
 * tier, and the floating jump-to-latest button as a sibling of the scroller.
 */
export const ThreadMessagesRegion = ({
  components,
  disabledReason,
  threadKey,
}: ThreadMessagesRegionProps) => {
  const messageIds = useThreadMessageIds();
  const messageCount = messageIds.length;
  const tier: ThreadRenderTier =
    messageCount >= THREAD_VIRTUALIZATION_THRESHOLD ? 'virtual' : 'static';

  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [virtualAtEnd, setVirtualAtEnd] = useState(true);
  // The vendor only notifies React when its range or isScrolling changes.
  // Pinnedness can change inside one range during the same scroll gesture.
  // Wrap its public observer so it remains the sole listener/scroll owner,
  // then publish the end predicate after it has consumed every offset.
  const observeVirtualOffset = useCallback(
    (
      instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
      callback: (offset: number, isScrolling: boolean) => void
    ) =>
      observeElementOffset(instance, (offset, isScrolling) => {
        callback(offset, isScrolling);
        setVirtualAtEnd(instance.isAtEnd());
      }),
    []
  );
  // Pinnedness as the FOLLOW ENGINE sees it. The DOM cannot answer this at
  // swap time (see the anchor effect), so the static tier's own signal is
  // recorded while it is still the truth.
  const follow = useThreadScrollFollow();
  const isAtBottom = useThreadFollowIsAtBottom();

  // ONE SCROLL OWNER per tier: the follow engine attaches only on the static
  // tier; on tier 2 the virtualizer writes scrollTop and the engine idles
  // with no element. Identity changes only on [follow, tier] — never per
  // render — which is the stable-lifecycle guarantee the extracted engine
  // exists to provide (see thread-scroll-follow.tsx).
  const scrollerRef = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      if (!el || tier !== 'static') {
        return;
      }
      return follow.attach(el);
    },
    [follow, tier]
  );

  // Thread-switch jump (parity with the library's scrollToBottomOnThreadSwitch,
  // static tier only): switching conversations opens at the newest message.
  // Initial mount deliberately does NOT jump — reopening a thread restores its
  // position (docs/agents/assistant-persistence.md).
  const switchKeyRef = useRef(threadKey);
  useLayoutEffect(() => {
    if (switchKeyRef.current === threadKey) {
      return;
    }
    switchKeyRef.current = threadKey;
    if (tier === 'static') {
      follow.jumpToBottomInstant();
    }
  }, [follow, threadKey, tier]);

  // Anything rendered ABOVE the virtual list inside the scroller (the disabled
  // notice) offsets every item; `scrollMargin` is how the virtualizer accounts
  // for it. Measured only when that content changes, never per scroll frame.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const next = listRef.current?.offsetTop ?? 0;
    setScrollMargin((current) => (current === next ? current : next));
  }, [disabledReason, tier]);

  /**
   * The React Compiler skips memoizing this component because `useVirtualizer`
   * returns functions that cannot be memoized safely. That is the DESIRED
   * outcome here, not a defect to work around: the virtualizer's own
   * `useReducer` re-render is the only signal that the visible range moved, so
   * this component MUST re-render on every scroll frame. Memoizing it would
   * freeze the row list — the exact failure the rule warns about is what the
   * opt-out prevents.
   *
   * Nothing derived from the instance escapes into a memoizable boundary: the
   * row list is rendered inline below, and the jump button receives plain
   * `{ atEnd, jumpToEnd }` values rather than the instance itself.
   *
   * Suppressed inline rather than by the upstream canonical fix (`'use no
   * memo'`), which `pnpm run lint:no-no-memo` forbids repo-wide, and rather
   * than in doctor.config.ts, which would not quiet ESLint and would move the
   * rationale away from the call site. Extraction does NOT help — the
   * diagnostic follows the `useVirtualizer()` call into whatever file it lives
   * in (measured), and tree-table.tsx:1050 carries the identical finding.
   */
  /* eslint-disable react-hooks/incompatible-library -- Re-enabled immediately after the call. A block form is required because react-doctor demands its own suppression be ADJACENT to the diagnostic, which leaves no room for an `eslint-disable-next-line` above it. */
  // react-doctor-disable-next-line react-hooks-js/incompatible-library -- The compiler opt-out is the intended behaviour: this component must re-render per scroll frame, and no virtualizer-derived value crosses a memoized boundary.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    // End-anchored chat mode: prepends (branch switches, history hydration)
    // keep the visual position, and appends follow only while already pinned.
    anchorTo: 'end',
    count: tier === 'virtual' ? messageCount : 0,
    directDomUpdates: true,
    enabled: tier === 'virtual',
    estimateSize: () => THREAD_MESSAGE_ESTIMATED_HEIGHT_PX,
    followOnAppend: 'instant',
    // Stable identity per message — NEVER the index, or a prepend would
    // re-key every row and throw away its measurement. The index arm is only
    // reachable when the virtualizer probes a stale index while diffing the
    // PREVIOUS option set against a shorter list; those keys are compared, not
    // rendered, and it matches the library's own default extractor.
    getItemKey: (index) => messageIds[index] ?? index,
    getScrollElement: () => viewportRef.current,
    observeElementOffset: observeVirtualOffset,
    // Size changes also change pinnedness, even without a new scroll offset.
    onChange: (instance) => setVirtualAtEnd(instance.isAtEnd()),
    overscan: THREAD_VIRTUAL_OVERSCAN,
    scrollEndThreshold: THREAD_END_THRESHOLD_PX,
    scrollMargin,
    // A delayed scroll-reset timer replays its last event's offset, which can
    // precede synchronous row-resize compensation. Native scrollend reads the
    // current offset and preserves the pin while lazy message rows hydrate.
    useScrollendEvent: true,
  });
  /* eslint-enable react-hooks/incompatible-library */

  // Read the mounted range in the component that owns the virtualizer. Its
  // instance is stable; offset-only end-state changes are published separately.
  const virtualItems = virtualizer.getVirtualItems();
  const setVirtualList = useCallback(
    (element: HTMLDivElement | null): void => {
      listRef.current = element;
      virtualizer.containerRef(element);
    },
    [virtualizer]
  );

  /**
   * Tier-2 equivalent of the persistence contract's opening position.
   *
   * `scrollToBottomOnInitialize={false}` keeps the LIBRARY from jumping on
   * tier 1. Tier 2 has no such library step, so entering the tier anchors to
   * the newest message explicitly — but only when the user was not already
   * reading further up (a thread that crosses the threshold mid-session must
   * not yank the viewport away). `instant`: never animate an opening position.
   *
   * Pinnedness is RECORDED while the static tier is still mounted, never
   * measured here. This effect runs after the commit that already swapped the
   * renderer, so the viewport is sized by the virtualizer's ESTIMATES by now,
   * not by the static list's real heights: measuring `scrollHeight` would
   * compare a stale `scrollTop` against a size that just changed, and whether
   * the reader looked "pinned" would depend on whether the estimate happened
   * to run above or below the real row height.
   */
  const anchorStateRef = useRef({
    enteredVirtual: false,
    pinnedWhileStatic: true,
    renderedStatic: false,
    threadKey,
  });
  useLayoutEffect(() => {
    const anchorState = anchorStateRef.current;
    if (anchorState.threadKey !== threadKey) {
      anchorState.threadKey = threadKey;
      anchorState.enteredVirtual = false;
      anchorState.renderedStatic = false;
      anchorState.pinnedWhileStatic = true;
    }

    if (tier === 'static') {
      anchorState.pinnedWhileStatic = isAtBottom;
      if (messageCount > 0) {
        anchorState.renderedStatic = true;
      }
      // Re-arm: a thread that drops back under the threshold (branch switch,
      // message deletion) must anchor again when it next crosses up.
      anchorState.enteredVirtual = false;
      return;
    }
    if (messageCount === 0 || anchorState.enteredVirtual) {
      return;
    }
    anchorState.enteredVirtual = true;

    // A thread that opened straight into the virtual tier has no reading
    // position to preserve — that is the restored-thread case.
    if (!anchorState.renderedStatic || anchorState.pinnedWhileStatic) {
      virtualizer.scrollToEnd({ behavior: 'instant' });
    }
  }, [isAtBottom, messageCount, threadKey, tier, virtualizer]);

  return (
    /**
     * SCROLL REGION: the wrapper is the viewport's positioning context. It
     * takes over the viewport's flex role so the floating jump-to-latest button
     * can overlay the messages without scrolling away with them, and without
     * being a child of the scroller, and it publishes the pinned state that
     * scopes `overflow-anchor` on the static tier.
     *
     * The viewport's className is ONLY "aui-thread-viewport" — no Tailwind
     * classes. The @assistant-ui library applies its own classes via @apply,
     * and layout constraints live in overrides.css (with !important) instead.
     */
    <ThreadScrollRegion>
      <div
        aria-atomic="false"
        // Every insertion into a live region is an announcement. On the static
        // tier the only insertions are new messages, so "polite" reads them out
        // as they arrive. On the virtual tier the virtualizer mounts and
        // unmounts rows as the user SCROLLS, so the same setting would read out
        // every row entering the overscan window — announcements the user did
        // not ask for, drowning the ones they did. Off is the lesser loss until
        // a dedicated new-message live region exists (see assistant-runtime.md).
        aria-live={tier === 'static' ? 'polite' : 'off'}
        // A PLAIN div, not ThreadPrimitive.Viewport: the library's viewport
        // (and its auto-scroll/viewport-store machinery) is deliberately out
        // of the loop on BOTH tiers — tier 1 scrolling is owned by the repo's
        // follow engine (thread-scroll-follow.tsx), tier 2 by the
        // virtualizer. The class stays `aui-thread-viewport` so the library's
        // stylesheet and overrides.css keep applying unchanged.
        className="aui-thread-viewport"
        data-testid="assistant-ui-viewport"
        data-thread-message-count={messageCount}
        data-thread-render-tier={tier}
        ref={scrollerRef}
      >
        {disabledReason && (
          <p aria-live="polite" className="px-4 py-3 text-muted-foreground text-xs">
            {disabledReason}
          </p>
        )}
        <AssistantThreadStateProvider>
          {tier === 'virtual' ? (
            /**
             * Rows are absolutely positioned inside ONE sizing container (the
             * TanStack chat pattern) — never `column-reverse`, which inverts
             * selection and keyboard order. This list stays inline in the
             * component that owns the virtualizer: the instance's identity is
             * stable, so a child component taking it as a prop could be
             * memoized into never re-rendering as the scroll range moves.
             */
            <div
              className="bs-virtual-thread"
              ref={setVirtualList}
              style={{ position: 'relative' }}
            >
              {virtualItems.map((item) => (
                <div
                  className="bs-virtual-message"
                  data-index={item.index}
                  // Spacing stays inside the measured row (see overrides.css).
                  // The vendor owns the container size and row transform as one
                  // update; React must not also write those layout properties.
                  data-last-message={item.index === messageCount - 1 ? '' : undefined}
                  key={item.key}
                  ref={virtualizer.measureElement}
                  style={{
                    left: 0,
                    position: 'absolute',
                    top: 0,
                    width: '100%',
                  }}
                >
                  <ThreadPrimitive.Unstable_MessageById
                    components={components}
                    messageId={String(item.key)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <ThreadPrimitive.Messages components={components} />
          )}
        </AssistantThreadStateProvider>
      </div>
      <ThreadScrollToBottom
        virtualScroll={
          tier === 'virtual'
            ? {
                atEnd: virtualAtEnd,
                jumpToEnd: () =>
                  virtualizer.scrollToEnd({
                    behavior: prefersReducedMotion() ? 'instant' : 'smooth',
                  }),
              }
            : null
        }
      />
    </ThreadScrollRegion>
  );
};
