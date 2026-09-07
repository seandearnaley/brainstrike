import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { ThreadScrollRegion, ThreadScrollToBottom } from '../assistant-ui-panel';
import { ThreadScrollFollowProvider, useThreadFollowScrollerRef } from '../thread-scroll-follow';
import '@brainstrike/ui/globals.css';
import '../overrides.css';

/**
 * BST-896: modern stick-to-bottom scrolling. The thread follows streaming
 * growth while pinned at the bottom, disengages the moment the user scrolls
 * up (streaming must NEVER steal the viewport back), and offers a floating
 * "jump to latest" button that is visible ONLY while scrolled up.
 *
 * These assertions run against the REPO-OWNED follow engine
 * (thread-scroll-follow.tsx — real scroll events, real ResizeObserver /
 * MutationObserver) and the REAL overrides.css rules in real Chromium — the
 * hidden/visible states are computed styles, not class names (this package
 * never compiles Tailwind; see assistant-chat-polish).
 */

const MESSAGE_HEIGHT_PX = 90;
const MESSAGE_COUNT = 12;
const VIEWPORT_HEIGHT_PX = 320;

const idleModel: ChatModelAdapter = {
  run: () => Promise.resolve({ content: [], status: { reason: 'stop', type: 'complete' } }),
};

const initialMessages: readonly ThreadMessageLike[] = Array.from(
  { length: MESSAGE_COUNT },
  (_, index) => ({
    content: [{ text: `message ${index + 1}`, type: 'text' as const }],
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
  })
);

const TallMessage = () => (
  <div
    className="bs-scroll-test-message"
    data-testid="thread-message"
    // The library viewport is a flex column; real messages are sized by their
    // content, so pin these stand-ins instead of letting flex shrink them.
    style={{ flexShrink: 0, height: MESSAGE_HEIGHT_PX }}
  />
);

const GROWTH_HEIGHT_PX = 400;

/**
 * Mirrors the panel's thread layout, using the panel's OWN scroll region (which
 * publishes `data-pinned`), follow engine, and button — the same real wiring
 * ThreadMessagesRegion uses (useThreadFollowScrollerRef).
 *
 * `growth` injects a block either BELOW the messages (streaming a reply) or
 * ABOVE them (async markdown/Shiki, images, folding tool cards) — the two
 * directions have different correct behaviors while the user is scrolled up.
 */
function ScrollerWithFollow({ children }: { children: React.ReactNode }) {
  const scrollerRef = useThreadFollowScrollerRef();
  return (
    <div className="aui-thread-viewport" data-testid="assistant-ui-viewport" ref={scrollerRef}>
      {children}
    </div>
  );
}

function ScrollHarness({ growth }: { growth: 'above' | 'below' | 'none' }) {
  const runtime = useLocalRuntime(idleModel, { initialMessages });
  const growthBlock = (
    <div data-testid="growth" style={{ flexShrink: 0, height: GROWTH_HEIGHT_PX }} />
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadScrollFollowProvider>
        <div className="assistant-ui-panel">
          <div
            className="bs-thread"
            data-testid="thread-column"
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: VIEWPORT_HEIGHT_PX,
              width: 420,
            }}
          >
            <ThreadScrollRegion>
              <ScrollerWithFollow>
                {growth === 'above' ? growthBlock : null}
                <ThreadPrimitive.Messages
                  components={{ AssistantMessage: TallMessage, UserMessage: TallMessage }}
                />
                {growth === 'below' ? growthBlock : null}
              </ScrollerWithFollow>
              <ThreadScrollToBottom />
            </ThreadScrollRegion>
          </div>
        </div>
      </ThreadScrollFollowProvider>
    </AssistantRuntimeProvider>
  );
}

function GrowingScrollHarness({ direction }: { direction: 'above' | 'below' }) {
  const [grown, setGrown] = useState(false);

  return (
    <>
      <button data-testid="grow" onClick={() => setGrown(true)} type="button">
        grow
      </button>
      <ScrollHarness growth={grown ? direction : 'none'} />
    </>
  );
}

const getViewport = (): HTMLElement => screen.getByTestId('assistant-ui-viewport');
const getButton = (): HTMLButtonElement =>
  screen.getByTestId('assistant-scroll-to-bottom') as HTMLButtonElement;

const distanceFromBottom = (el: HTMLElement): number =>
  Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight);

/**
 * The thread hydrates asynchronously; wait for a real overflowing scroller that
 * has settled at the bottom (`autoScroll` pins a freshly opened thread there).
 */
const waitForPinnedThread = async (): Promise<HTMLElement> => {
  await screen.findAllByTestId('thread-message');
  const viewport = getViewport();
  await waitFor(() => {
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight + 1);
    expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
  });
  return viewport;
};

/**
 * Simulate a user scrolling up. `.aui-thread-viewport` carries the library's
 * `scroll-behavior: smooth`, so a bare `scrollTop =` assignment ANIMATES;
 * `behavior: 'instant'` lands the position deterministically.
 */
const scrollUpTo = async (viewport: HTMLElement, top: number): Promise<void> => {
  viewport.scrollTo({ behavior: 'instant', top });
  await waitFor(() => {
    expect(viewport.scrollTop).toBe(top);
  });
};

const waitForOpacity = async (button: HTMLButtonElement, opacity: string): Promise<void> => {
  await waitFor(() => {
    expect(getComputedStyle(button).opacity).toBe(opacity);
  });
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('jump-to-latest button (real browser, BST-896)', () => {
  test('stays hidden while the thread is pinned at the bottom', async () => {
    render(<ScrollHarness growth="none" />);
    await waitForPinnedThread();

    const button = getButton();
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    await waitForOpacity(button, '0');
    expect(getComputedStyle(button).pointerEvents).toBe('none');
  });

  test('appears once the user scrolls up', async () => {
    render(<ScrollHarness growth="none" />);
    const viewport = await waitForPinnedThread();

    await scrollUpTo(viewport, 0);

    const button = getButton();
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    await waitForOpacity(button, '1');
    expect(getComputedStyle(button).pointerEvents).not.toBe('none');
    // It overlays the messages instead of taking layout space.
    expect(getComputedStyle(button).position).toBe('absolute');
  });

  test('clicking it returns the viewport to the bottom and hides itself again', async () => {
    render(<ScrollHarness growth="none" />);
    const viewport = await waitForPinnedThread();

    await scrollUpTo(viewport, 0);
    const button = getButton();
    await waitFor(() => {
      expect(button).toBeEnabled();
    });

    fireEvent.click(button);

    await waitFor(() => {
      expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
    });
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    await waitForOpacity(button, '0');
  });

  test('content growth while scrolled up never steals the viewport', async () => {
    render(<GrowingScrollHarness direction="below" />);
    const viewport = await waitForPinnedThread();

    await scrollUpTo(viewport, MESSAGE_HEIGHT_PX);
    const button = getButton();
    await waitFor(() => {
      expect(button).toBeEnabled();
    });

    const scrollHeightBefore = viewport.scrollHeight;
    fireEvent.click(screen.getByTestId('grow'));

    // The growth lands (ResizeObserver fires) …
    await waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(scrollHeightBefore);
    });
    // … and the reading position is untouched, with the affordance still offered.
    expect(viewport.scrollTop).toBe(MESSAGE_HEIGHT_PX);
    expect(button).toBeEnabled();
  });
});

/**
 * `overflow-anchor: none` is scoped to the PINNED state on purpose. Pinned, JS
 * owns scrollTop and native anchoring would double-adjust; scrolled up, the
 * library never writes scrollTop, so native anchoring is the only thing keeping
 * the reader's text still when content ABOVE the viewport resizes.
 */
describe('scroll-anchor scoping (real browser, BST-896)', () => {
  test('anchoring is off only while pinned, and back on once the user scrolls up', async () => {
    render(<ScrollHarness growth="none" />);
    const viewport = await waitForPinnedThread();

    await waitFor(() => {
      expect(getComputedStyle(viewport).overflowAnchor).toBe('none');
    });

    await scrollUpTo(viewport, MESSAGE_HEIGHT_PX);

    await waitFor(() => {
      expect(getComputedStyle(viewport).overflowAnchor).toBe('auto');
    });
  });

  test('growth ABOVE the reading position keeps the visible text still', async () => {
    render(<GrowingScrollHarness direction="above" />);
    const viewport = await waitForPinnedThread();

    // Park mid-thread so there is real content above AND below the fold.
    await scrollUpTo(viewport, MESSAGE_HEIGHT_PX * 4);
    await waitFor(() => {
      expect(getButton()).toBeEnabled();
    });

    const readingAnchor = screen.getAllByTestId('thread-message')[7];
    if (!readingAnchor) {
      throw new Error('expected a mid-thread message to use as the reading anchor');
    }
    const offsetBefore =
      readingAnchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const scrollHeightBefore = viewport.scrollHeight;

    fireEvent.click(screen.getByTestId('grow'));
    await waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(scrollHeightBefore);
    });

    // Native anchoring absorbs the inserted height: scrollTop moves DOWN by it,
    // so the text the reader is looking at does not move on screen.
    await waitFor(() => {
      const offsetAfter =
        readingAnchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThanOrEqual(1);
    });
    expect(viewport.scrollTop).toBe(MESSAGE_HEIGHT_PX * 4 + GROWTH_HEIGHT_PX);
  });
});

/**
 * The engine's OWN write echoing back must never unpin follow (BST-1039).
 *
 * `measure` writes `scrollTop` synchronously and judges the result in the same
 * breath, clearing `pendingFollow`; the browser dispatches that write's
 * `scroll` event a task LATER. The event carries no position of its own —
 * `handleScroll` re-reads LIVE geometry — so if the viewport is resized in
 * between, the leftover event is judged against dimensions the engine has
 * never measured: "not at bottom, and the position did not move down", which
 * is indistinguishable from a reader parked above the end. Follow disengaged
 * with no user act and never came back, because `measure` only re-sticks while
 * pinned.
 *
 * The window is real: the follow-up queue's chip row shrinks the viewport from
 * OUTSIDE the scroller while a streamed chunk grows the content inside it, and
 * neither fires a scroll event of its own. It was a ~9% `Browser tests` flake
 * in follow-up-queue-repin.browser.test.tsx, landing exactly
 * `SQUEEZE + GROWTH` px short of the bottom every single time.
 *
 * Both cases below force that window deterministically — the squeeze, the
 * growth and the event share ONE synchronous task, so neither observer can
 * have measured yet — and differ only in WHO moved the position. That is the
 * whole discriminator, and the second case is why it cannot be "did scrollTop
 * move": scroll events coalesce, so a user round trip reaches the engine as a
 * single event whose net movement is zero, and it must still disengage.
 */
const STALE_SQUEEZE_PX = 65;
const STALE_GROWTH_PX = 30;

/**
 * Shrinks the viewport from OUTSIDE the scroller (what the chip row does —
 * only the ResizeObserver can see it) and grows the content INSIDE it (what a
 * streamed chunk does — only the MutationObserver can see it), synchronously,
 * so the caller can dispatch a scroll event before either observer measures.
 */
const squeezeAndGrow = (viewport: HTMLElement): void => {
  const footer = document.createElement('div');
  footer.style.flexShrink = '0';
  footer.style.height = `${STALE_SQUEEZE_PX}px`;
  screen.getByTestId('thread-column').append(footer);
  const growth = document.createElement('div');
  growth.style.flexShrink = '0';
  growth.style.height = `${STALE_GROWTH_PX}px`;
  viewport.append(growth);
};

describe('stale scroll events never unpin follow (real browser, BST-1039)', () => {
  test("the engine's own write echoing back after a viewport squeeze keeps follow engaged", async () => {
    render(<ScrollHarness growth="none" />);
    const viewport = await waitForPinnedThread();
    const button = getButton();
    await waitFor(() => {
      expect(button).toBeDisabled();
    });

    const scrollTopBefore = viewport.scrollTop;
    squeezeAndGrow(viewport);
    // Nothing moved the reading position — the engine still owns it.
    expect(viewport.scrollTop).toBe(scrollTopBefore);
    // Deliver the scroll event the engine's own earlier write left queued.
    viewport.dispatchEvent(new Event('scroll'));

    // Follow survives and re-sticks once the observers land. Before the fix it
    // sat exactly STALE_SQUEEZE_PX + STALE_GROWTH_PX short, permanently.
    await waitFor(() => {
      expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
    });
    expect(button).toBeDisabled();
  });

  test('a reader scrolling in that same window still disengages, and is not yanked back', async () => {
    render(<ScrollHarness growth="none" />);
    const viewport = await waitForPinnedThread();
    const button = getButton();
    await waitFor(() => {
      expect(button).toBeDisabled();
    });

    squeezeAndGrow(viewport);
    // Identical window, but the READER moved the position. Unmeasured geometry
    // must not buy follow the benefit of the doubt here: swallowing this event
    // leaves `isAtBottom` true, and the very next `measure` yanks them back.
    viewport.scrollTo({ behavior: 'instant', top: 0 });
    viewport.dispatchEvent(new Event('scroll'));

    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    // Give the deferred measurement a beat to prove it does not re-stick.
    await new Promise((resolvePause) => setTimeout(resolvePause, 300));
    expect(viewport.scrollTop).toBe(0);
    expect(button).toBeEnabled();
  });
});
