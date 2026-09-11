import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, getConfig, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import {
  THREAD_END_THRESHOLD_PX,
  THREAD_VIRTUALIZATION_THRESHOLD,
  ThreadMessagesRegion,
} from '../assistant-thread-messages';
import { ThreadScrollFollowProvider } from '../thread-scroll-follow';
import '@brainstrike/ui/globals.css';
import '../overrides.css';

/**
 * BST-897: the two-tier thread renderer.
 *
 * Tier 1 ("static") renders every message as a real DOM row and leans on CSS
 * containment (`content-visibility: auto`) to keep off-screen rows cheap.
 * Tier 2 ("virtual") takes over above THREAD_VIRTUALIZATION_THRESHOLD messages
 * and hands scroll ownership to an end-anchored TanStack virtualizer.
 *
 * Everything here runs in real Chromium against the real @assistant-ui runtime,
 * the real virtualizer and the real overrides.css: DOM counts, scroll offsets
 * and computed styles are measured, never mocked.
 */

const MESSAGE_HEIGHT_PX = 90;
const GROWN_MESSAGE_HEIGHT_PX = 640;
const VIEWPORT_HEIGHT_PX = 320;
const APPEND_TEST_INITIAL_MESSAGE_COUNT = 600;
/** Marks a message whose stand-in renders tall — our stand-in for streaming growth. */
const GROWN_PREFIX = 'grown:';

interface HarnessMessage {
  readonly id: string;
  readonly role: 'assistant' | 'user';
  readonly text: string;
}

const makeMessages = (count: number): readonly HarnessMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `message ${index}`,
  }));

const convertMessage = (message: HarnessMessage): ThreadMessageLike => ({
  content: [{ text: message.text, type: 'text' }],
  id: message.id,
  role: message.role,
});

/**
 * Stand-in message row. It mirrors the two things the renderer depends on: the
 * `.aui-*-message-root` class (the containment/centering selectors key off it)
 * and a content-driven height (so "the last message grew" is a real reflow).
 */
const StandInMessage = ({ className }: { className: string }) => {
  const text = useAuiState((s) => {
    const [part] = s.message.content;
    return part?.type === 'text' ? part.text : '';
  });

  return (
    <div
      className={className}
      data-message-text={text}
      data-testid="thread-message"
      style={{
        flexShrink: 0,
        height: text.startsWith(GROWN_PREFIX) ? GROWN_MESSAGE_HEIGHT_PX : MESSAGE_HEIGHT_PX,
      }}
    />
  );
};

const UserStandIn = () => <StandInMessage className="aui-user-message-root" />;
const AssistantStandIn = () => <StandInMessage className="aui-assistant-message-root" />;

const STAND_IN_COMPONENTS = {
  AssistantMessage: AssistantStandIn,
  UserMessage: UserStandIn,
};

const noopNew = (_message: AppendMessage): Promise<void> => Promise.resolve();

function ThreadHarness({ messages }: { messages: readonly HarnessMessage[] }) {
  const runtime = useExternalStoreRuntime({
    convertMessage,
    messages,
    onNew: noopNew,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadScrollFollowProvider>
        <div className="assistant-ui-panel">
          <div
            className="bs-thread"
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: VIEWPORT_HEIGHT_PX,
              width: 420,
            }}
          >
            <ThreadMessagesRegion components={STAND_IN_COMPONENTS} />
          </div>
        </div>
      </ThreadScrollFollowProvider>
    </AssistantRuntimeProvider>
  );
}

/**
 * Perf baseline only: the pre-BST-897 shape — every message mounted, no tier
 * switching — so the virtualized tier can be measured against it at the same N.
 */
function UntieredThreadHarness({ messages }: { messages: readonly HarnessMessage[] }) {
  const runtime = useExternalStoreRuntime({ convertMessage, messages, onNew: noopNew });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="assistant-ui-panel">
        <div
          className="bs-thread"
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: VIEWPORT_HEIGHT_PX,
            width: 420,
          }}
        >
          <ThreadPrimitive.Viewport autoScroll className="aui-thread-viewport">
            <ThreadPrimitive.Messages components={STAND_IN_COMPONENTS} />
          </ThreadPrimitive.Viewport>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

/** Harness whose message list can be mutated from the test (append / grow). */
function MutableThreadHarness({ initialCount }: { initialCount: number }) {
  const [messages, setMessages] = useState<readonly HarnessMessage[]>(() =>
    makeMessages(initialCount)
  );

  return (
    <>
      <button
        data-testid="append"
        onClick={() =>
          setMessages((current) => [
            ...current,
            { id: `appended-${current.length}`, role: 'assistant', text: 'appended' },
          ])
        }
        type="button"
      >
        append
      </button>
      <button
        data-testid="grow-last"
        onClick={() =>
          setMessages((current) =>
            current.map((message, index) =>
              index === current.length - 1
                ? { ...message, text: `${GROWN_PREFIX}${message.text}` }
                : message
            )
          )
        }
        type="button"
      >
        grow
      </button>
      <ThreadHarness messages={messages} />
    </>
  );
}

const getViewport = (): HTMLElement => screen.getByTestId('assistant-ui-viewport');
const getButton = (): HTMLButtonElement =>
  screen.getByTestId('assistant-scroll-to-bottom') as HTMLButtonElement;
const mountedMessageCount = (): number => screen.queryAllByTestId('thread-message').length;

const distanceFromBottom = (el: HTMLElement): number =>
  Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight);

const waitForOverflowingViewport = async (): Promise<HTMLElement> => {
  await screen.findAllByTestId('thread-message');
  const viewport = getViewport();
  await waitFor(() => {
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight + 1);
  });
  return viewport;
};

/**
 * Budget for waits that a contended CI runner can lose. Deliberately far above
 * the frame or two these actually take: exhausting one of these is a HARD test
 * failure, not a retry, and load-induced slowness is the exact condition this
 * file's flakes came from — so the budget must not double as a timing
 * assumption. Generous here costs nothing; every one of these waits returns as
 * soon as its condition holds.
 */
const SETTLE_TIMEOUT_MS = Math.max(5000, getConfig().asyncUtilTimeout);

/**
 * Settling after a scroll correction: measure → adjust → re-render. Tier 2 does
 * this on its own; on tier 1 it is the library's autoScroll pinning, which both
 * threshold-crossing tests below wait out before they touch the position.
 */
const waitForPinnedToEnd = async (viewport: HTMLElement): Promise<void> => {
  await waitFor(
    () => {
      expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(2);
    },
    { timeout: SETTLE_TIMEOUT_MS }
  );
};

const scrollTo = async (viewport: HTMLElement, top: number): Promise<void> => {
  viewport.scrollTo({ behavior: 'instant', top });
  await waitFor(() => {
    expect(Math.abs(viewport.scrollTop - top)).toBeLessThanOrEqual(1);
  });
};

const expectScrollTopStableAcrossFrames = async (
  viewport: HTMLElement,
  expectedScrollTop: number
): Promise<void> => {
  // The first frame lets layout and ResizeObserver consume the appended count;
  // the next two samples prove their deferred corrections preserve position.
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });

  await act(nextFrame);
  for (let frame = 0; frame < 2; frame += 1) {
    await act(nextFrame);
    expect(Math.abs(viewport.scrollTop - expectedScrollTop)).toBeLessThanOrEqual(2);
  }
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('thread render tier switching (BST-897)', () => {
  test('stays on the static tier below the virtualization threshold', async () => {
    render(<ThreadHarness messages={makeMessages(12)} />);
    await screen.findAllByTestId('thread-message');

    expect(getViewport()).toHaveAttribute('data-thread-render-tier', 'static');
    expect(mountedMessageCount()).toBe(12);
  });

  test('switches to the virtual tier at or above the threshold', async () => {
    render(<ThreadHarness messages={makeMessages(THREAD_VIRTUALIZATION_THRESHOLD)} />);
    await screen.findAllByTestId('thread-message');

    expect(getViewport()).toHaveAttribute('data-thread-render-tier', 'virtual');
  });

  test('forces overflow-anchor: none on the virtualized viewport', async () => {
    render(<ThreadHarness messages={makeMessages(THREAD_VIRTUALIZATION_THRESHOLD)} />);
    await screen.findAllByTestId('thread-message');

    // The virtualizer writes scrollTop in EVERY state (measurement corrections
    // fire while scrolled up too), so native scroll anchoring must never add a
    // second adjustment here — unlike tier 1, where it is only suppressed while
    // the library is actively pinning.
    expect(getComputedStyle(getViewport()).overflowAnchor).toBe('none');
  });
});

describe('static tier CSS containment (BST-897)', () => {
  test('contains off-screen message rows but never the last (streaming) row', async () => {
    render(<ThreadHarness messages={makeMessages(12)} />);
    const rows = await screen.findAllByTestId('thread-message');
    const firstRow = rows[0] as HTMLElement;
    const lastRow = rows.at(-1) as HTMLElement;

    await waitFor(() => {
      expect(getComputedStyle(firstRow).contentVisibility).toBe('auto');
    });
    expect(getComputedStyle(firstRow).containIntrinsicSize).not.toBe('none');
    // The actively streaming message is always the last row; containment there
    // fights incremental growth (the intrinsic size lags the real content).
    expect(getComputedStyle(lastRow).contentVisibility).toBe('visible');
  });
});

describe('virtualized tier (BST-897)', () => {
  test('mounts a bounded number of rows for a 1000-message thread', async () => {
    render(<ThreadHarness messages={makeMessages(1000)} />);
    const viewport = await waitForOverflowingViewport();
    await waitForPinnedToEnd(viewport);

    expect(viewport).toHaveAttribute('data-thread-render-tier', 'virtual');
    expect(mountedMessageCount()).toBeLessThan(100);
    expect(mountedMessageCount()).toBeGreaterThan(0);

    // All 1000 are reachable: the scroll range covers the whole thread and the
    // first message renders once scrolled to the top.
    expect(viewport.scrollHeight).toBeGreaterThan(1000 * MESSAGE_HEIGHT_PX * 0.9);
    await scrollTo(viewport, 0);
    await waitFor(() => {
      expect(document.querySelector('[data-message-text="message 0"]')).not.toBeNull();
    });
    expect(mountedMessageCount()).toBeLessThan(100);
  });

  test('an initially restored thread opens at the latest message', async () => {
    render(<ThreadHarness messages={makeMessages(1000)} />);
    const viewport = await waitForOverflowingViewport();
    await waitForPinnedToEnd(viewport);

    await waitFor(() => {
      expect(document.querySelector('[data-message-text="message 999"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-message-text="message 0"]')).toBeNull();
  });

  test('appending while scrolled up never steals the viewport, and the jump button returns to the end', async () => {
    render(<MutableThreadHarness initialCount={APPEND_TEST_INITIAL_MESSAGE_COUNT} />);
    const viewport = await waitForOverflowingViewport();
    await waitForPinnedToEnd(viewport);

    const button = getButton();
    // Pinned geometry settles before the button's virtualizer state. Establish
    // the disabled starting state so the enabled wait below observes a real
    // transition instead of passing on a stale opening render.
    await waitFor(
      () => {
        expect(button).toBeDisabled();
      },
      { timeout: SETTLE_TIMEOUT_MS }
    );

    // A matching DOM offset can precede the virtualizer's opening rAF
    // reconciliation. Establish a painted, pinned viewport before asking the
    // reader to move; otherwise that unfinished index scroll owns the append.
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await waitForPinnedToEnd(viewport);

    // Clamp a one-viewport move to the mounted end window. Jumping into
    // unmounted estimates makes row measurement corrections indistinguishable
    // from append movement, which is not the contract this test owns.
    const firstMountedRow = screen.getAllByTestId('thread-message')[0];
    if (!firstMountedRow) {
      throw new Error('Expected the virtualizer to have a mounted end window');
    }
    const viewportRect = viewport.getBoundingClientRect();
    const mountedStart =
      viewport.scrollTop +
      firstMountedRow.getBoundingClientRect().top -
      viewportRect.top -
      viewport.clientTop;
    const scrollTopAtEnd = viewport.scrollTop;
    const target = Math.max(mountedStart, scrollTopAtEnd - viewport.clientHeight);
    if (scrollTopAtEnd - target <= THREAD_END_THRESHOLD_PX) {
      throw new Error('Expected the mounted window to permit a scrolled-up reading position');
    }
    await scrollTo(viewport, target);
    await waitFor(
      () => {
        expect(button).toBeEnabled();
      },
      { timeout: SETTLE_TIMEOUT_MS }
    );

    const scrollTopBefore = viewport.scrollTop;
    // Flush the append independently of whether the new row lands inside the
    // current overscan window.
    await act(async () => {
      fireEvent.click(screen.getByTestId('append'));
    });
    await waitFor(
      () => {
        expect(viewport).toHaveAttribute(
          'data-thread-message-count',
          String(APPEND_TEST_INITIAL_MESSAGE_COUNT + 1)
        );
      },
      { timeout: SETTLE_TIMEOUT_MS }
    );
    // The reading position remains untouched after the virtualizer consumes
    // the appended count and its frame-boundary measurements settle …
    await expectScrollTopStableAcrossFrames(viewport, scrollTopBefore);
    expect(button).toBeEnabled();

    // … and the jump button drives the virtualizer back to the true end.
    fireEvent.click(button);
    await waitForPinnedToEnd(viewport);
    await waitFor(
      () => {
        expect(document.querySelector('[data-message-text="appended"]')).not.toBeNull();
      },
      { timeout: SETTLE_TIMEOUT_MS }
    );
    await waitFor(
      () => {
        expect(button).toBeDisabled();
      },
      { timeout: SETTLE_TIMEOUT_MS }
    );
  });

  test('growth of the last message while pinned keeps the view at the true end', async () => {
    render(<MutableThreadHarness initialCount={600} />);
    const viewport = await waitForOverflowingViewport();
    await waitForPinnedToEnd(viewport);

    const scrollHeightBefore = viewport.scrollHeight;
    await act(async () => {
      fireEvent.click(screen.getByTestId('grow-last'));
    });

    await waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(scrollHeightBefore + 100);
    });
    await waitForPinnedToEnd(viewport);
    // waitFor, not a raw expect: the button's disabled state trails the
    // viewport's pinned position by a frame (scroll listener → state), and on
    // a contended CI runner that frame loses the race (BST-1042 — the
    // Browser-tests lane's first flake). The sibling jump-button test above
    // already wraps this same assertion.
    await waitFor(() => {
      expect(getButton()).toBeDisabled();
    });
  });
});

describe('crossing the virtualization threshold mid-session (BST-897)', () => {
  test('a reader pinned to the bottom on the static tier stays at the bottom after the switch', async () => {
    render(<MutableThreadHarness initialCount={THREAD_VIRTUALIZATION_THRESHOLD - 1} />);
    const viewport = await waitForOverflowingViewport();
    expect(viewport).toHaveAttribute('data-thread-render-tier', 'static');
    // The library pins a freshly opened thread; land there before crossing.
    viewport.scrollTo({ behavior: 'instant', top: viewport.scrollHeight });
    await waitForPinnedToEnd(viewport);

    fireEvent.click(screen.getByTestId('append'));

    await waitFor(() => {
      expect(viewport).toHaveAttribute('data-thread-render-tier', 'virtual');
    });
    // Pinnedness must be read from BEFORE the swap: afterwards the viewport is
    // sized by the virtualizer's estimates, not the static list's real height.
    await waitForPinnedToEnd(viewport);
    await waitFor(() => {
      expect(getButton()).toBeDisabled();
    });
  });

  test('a reader scrolled up on the static tier is not yanked by the switch', async () => {
    render(<MutableThreadHarness initialCount={THREAD_VIRTUALIZATION_THRESHOLD - 1} />);
    const viewport = await waitForOverflowingViewport();
    // The library pins a freshly opened thread; land there before scrolling
    // away, so the scroll-up is a real disengage rather than a write issued
    // while the library is still pinning. WRITTEN, not merely waited for: with
    // `scrollToBottomOnInitialize={false}` the opening pin is a side effect of
    // resize-driven follow, so a coalesced ResizeObserver notification would
    // leave waitForPinnedToEnd nothing to converge on — a second timing
    // assumption is the last thing a determinism fix should rest on. The raw
    // scrollTo, not the scrollTo() helper: the helper asserts `scrollTop ≈ top`,
    // which never holds for `scrollHeight` once the browser clamps it. Matches
    // the sibling test above.
    viewport.scrollTo({ behavior: 'instant', top: viewport.scrollHeight });
    await waitForPinnedToEnd(viewport);
    await scrollTo(viewport, 0);
    // scrollTo only proves the DOM moved — `scrollTop` is written synchronously,
    // so its waitFor passes on the first check. The LIBRARY's pinned state, which
    // is what the tier swap records as `pinnedWhileStatic`, trails it by a frame
    // (scroll listener → store → render): measured, the button is still DISABLED
    // in the same task the scroll lands. Appending inside that window makes the
    // swap take the "was pinned" branch and scrollToEnd() onto the newest
    // message — and that state is terminal, so the assertion below then sees 0
    // for its whole window and no amount of waiting recovers it — the same
    // one-frame lag as BST-1042, read by a different consumer.
    await waitFor(
      () => {
        expect(getButton()).toBeEnabled();
      },
      { timeout: SETTLE_TIMEOUT_MS }
    );

    fireEvent.click(screen.getByTestId('append'));

    await waitFor(() => {
      expect(viewport).toHaveAttribute('data-thread-render-tier', 'virtual');
    });
    // Position is not preserved exactly across a re-layout onto estimated row
    // heights, but the reader must NOT be thrown to the newest message.
    await waitFor(() => {
      expect(distanceFromBottom(viewport)).toBeGreaterThan(VIEWPORT_HEIGHT_PX);
    });
    await waitFor(() => {
      expect(getButton()).toBeEnabled();
    });
  });
});

describe('thread renderer performance evidence (BST-897)', () => {
  test('reports mounted DOM rows and mount time for both tiers at N=1000', async () => {
    // Tier-1 baseline at the SAME thread size: the un-tiered list the renderer
    // replaces, mounted through the library primitive directly.
    const staticStart = performance.now();
    render(<UntieredThreadHarness messages={makeMessages(1000)} />);
    await screen.findAllByTestId('thread-message');
    await waitFor(() => {
      expect(mountedMessageCount()).toBe(1000);
    });
    const staticMs = performance.now() - staticStart;
    const staticRows = mountedMessageCount();
    document.body.replaceChildren();

    const virtualStart = performance.now();
    render(<ThreadHarness messages={makeMessages(1000)} />);
    const viewport = await waitForOverflowingViewport();
    await waitForPinnedToEnd(viewport);
    const virtualMs = performance.now() - virtualStart;
    const virtualRows = mountedMessageCount();

    // Reported, not asserted: load-sensitive timings flake in CI. The only hard
    // budget is the DOM-row bound, which is a property of the renderer.
    console.info(
      `[BST-897] N=1000 — untiered list: ${staticRows} rows in ${staticMs.toFixed(0)}ms | virtualized tier: ${virtualRows} rows in ${virtualMs.toFixed(0)}ms`
    );
    expect(virtualRows).toBeLessThan(100);
    expect(staticRows).toBe(1000);
  });
});

test('keeps the end pin when a pending scroll reset lands between row resize deliveries', async () => {
  render(<ThreadHarness messages={makeMessages(600)} />);
  const viewport = await waitForOverflowingViewport();
  await waitForPinnedToEnd(viewport);
  const schedule = globalThis.setTimeout.bind(globalThis);
  let pendingReset: (() => void) | undefined;
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    if (delay === 150 && typeof handler === 'function') {
      pendingReset = () => handler(...args);
      return schedule(() => undefined, delay);
    }
    return schedule(handler, delay, ...args);
  });
  // Hold only the reset scheduled synchronously by this one scroll event;
  // unrelated mount and post-scroll timers keep their original behavior.
  try {
    fireEvent.scroll(viewport);
  } finally {
    timer.mockRestore();
  }
  expect(pendingReset).toBeUndefined();
  const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-testid="thread-message"]'));
  const last = rows.at(-1);
  if (!last) {
    throw new Error('Expected the newest message');
  }
  let armed = false;
  let delivered = false;
  const observer = new ResizeObserver(() => {
    if (!armed) {
      return;
    }
    armed = false;
    delivered = true;
    pendingReset?.();
    // The native path has no timer: scrollend reads the live offset instead.
    viewport.dispatchEvent(new Event('scrollend'));
    // A second layout change can arrive before the browser emits the scroll
    // event for the virtualizer's first compensation write. Creating this
    // observer after the virtualizer orders the two deliveries; Chromium can
    // report the second reflow as an undelivered ResizeObserver notification.
    for (const row of rows) {
      row.style.height = `${MESSAGE_HEIGHT_PX + 42}px`;
    }
  });
  observer.observe(last);
  onTestFinished(() => observer.disconnect());
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  armed = true;
  for (const row of rows) {
    row.style.height = `${MESSAGE_HEIGHT_PX + 21}px`;
  }
  await waitFor(() => expect(delivered).toBe(true));
  await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(2));
});

test('updates the jump affordance when scrolling crosses the end threshold within one virtual range', async () => {
  render(<ThreadHarness messages={makeMessages(600)} />);
  const viewport = screen.getByTestId('assistant-ui-viewport');
  const button = screen.getByTestId('assistant-scroll-to-bottom');
  const openingEnded = vi.fn();
  viewport.addEventListener('scrollend', openingEnded, { once: true });
  onTestFinished(() => viewport.removeEventListener('scrollend', openingEnded));
  // Wait for the opening scroll's actual native completion before testing a
  // new gesture. A momentary bottom position can precede row measurement.
  await waitFor(() => expect(openingEnded).toHaveBeenCalled());
  await waitForPinnedToEnd(viewport);
  expect(viewport).toHaveAttribute('data-thread-render-tier', 'virtual');

  act(() => {
    viewport.scrollTo({
      behavior: 'instant',
      top: viewport.scrollHeight - viewport.clientHeight - THREAD_END_THRESHOLD_PX - 1,
    });
    fireEvent.scroll(viewport);
  });
  expect(distanceFromBottom(viewport)).toBe(THREAD_END_THRESHOLD_PX + 1);
  expect(button).toBeEnabled();
  const mountedRows = Array.from(viewport.querySelectorAll('[data-index]'), (row) =>
    row.getAttribute('data-index')
  );

  expect(mountedRows.length).toBeGreaterThan(0);

  // Two consecutive scroll notifications in one animation frame have the same
  // isScrolling value and visible range. Crossing the affordance threshold must
  // still publish new state; no scrollend or incidental React render is needed.
  act(() => {
    viewport.scrollTo({ behavior: 'instant', top: viewport.scrollTop + 2 });
    fireEvent.scroll(viewport);
  });
  expect(
    Array.from(viewport.querySelectorAll('[data-index]'), (row) => row.getAttribute('data-index'))
  ).toEqual(mountedRows);
  expect(button).toBeDisabled();
});

test('reattaches vendor layout after a virtual to static to virtual round trip', async () => {
  const view = render(<ThreadHarness messages={makeMessages(600)} />);
  await waitForPinnedToEnd(screen.getByTestId('assistant-ui-viewport'));
  view.rerender(<ThreadHarness messages={makeMessages(20)} />);
  expect(screen.getByTestId('assistant-ui-viewport')).toHaveAttribute(
    'data-thread-render-tier',
    'static'
  );
  expect(document.querySelector('.bs-virtual-thread')).toBeNull();
  view.rerender(<ThreadHarness messages={makeMessages(600)} />);
  const viewport = screen.getByTestId('assistant-ui-viewport');
  expect(viewport).toHaveAttribute('data-thread-render-tier', 'virtual');
  await waitForPinnedToEnd(viewport);
  expect(
    document.querySelector('.bs-virtual-thread')?.getBoundingClientRect().height
  ).toBeGreaterThan(viewport.clientHeight);
  const button = screen.getByTestId('assistant-scroll-to-bottom');
  expect(button).toBeDisabled();
  act(() => {
    viewport.scrollTo({
      behavior: 'instant',
      top: viewport.scrollTop - THREAD_END_THRESHOLD_PX - 1,
    });
    fireEvent.scroll(viewport);
  });
  expect(button).toBeEnabled();
});
