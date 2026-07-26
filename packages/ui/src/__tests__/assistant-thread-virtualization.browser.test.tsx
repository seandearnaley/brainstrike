import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  THREAD_VIRTUALIZATION_THRESHOLD,
  ThreadMessagesRegion,
} from '../assistant-ui-panel/assistant-thread-messages';
import '../globals.css';
import '../assistant-ui-panel/overrides.css';

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

/** Tier 2 settles asynchronously: measure → adjust → re-render. */
const waitForPinnedToEnd = async (viewport: HTMLElement): Promise<void> => {
  await waitFor(
    () => {
      expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(2);
    },
    { timeout: 5000 }
  );
};

const scrollTo = async (viewport: HTMLElement, top: number): Promise<void> => {
  viewport.scrollTo({ behavior: 'instant', top });
  await waitFor(() => {
    expect(Math.abs(viewport.scrollTop - top)).toBeLessThanOrEqual(1);
  });
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
    render(<MutableThreadHarness initialCount={600} />);
    const viewport = await waitForOverflowingViewport();
    await waitForPinnedToEnd(viewport);

    await scrollTo(viewport, 4000);
    const button = getButton();
    await waitFor(() => {
      expect(button).toBeEnabled();
    });

    const scrollTopBefore = viewport.scrollTop;
    fireEvent.click(screen.getByTestId('append'));

    await waitFor(() => {
      expect(document.querySelector('[data-thread-render-tier]')).not.toBeNull();
    });
    // The reading position is untouched by the append …
    await waitFor(() => {
      expect(Math.abs(viewport.scrollTop - scrollTopBefore)).toBeLessThanOrEqual(2);
    });
    expect(button).toBeEnabled();

    // … and the jump button drives the virtualizer back to the true end.
    fireEvent.click(button);
    await waitForPinnedToEnd(viewport);
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
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
    expect(getButton()).toBeDisabled();
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
    await scrollTo(viewport, 0);

    fireEvent.click(screen.getByTestId('append'));

    await waitFor(() => {
      expect(viewport).toHaveAttribute('data-thread-render-tier', 'virtual');
    });
    // Position is not preserved exactly across a re-layout onto estimated row
    // heights, but the reader must NOT be thrown to the newest message.
    await waitFor(() => {
      expect(distanceFromBottom(viewport)).toBeGreaterThan(VIEWPORT_HEIGHT_PX);
    });
    expect(getButton()).toBeEnabled();
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
