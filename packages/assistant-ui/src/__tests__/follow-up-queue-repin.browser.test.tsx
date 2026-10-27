import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
} from '@assistant-ui/react';
import { useEffect } from 'react';
import '@testing-library/jest-dom/vitest';
import { act } from '@brainstrike/test-utils/react-act';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ThreadScrollRegion, ThreadScrollToBottom } from '../assistant-ui-panel';
import { FollowUpQueueChips } from '../follow-up-queue';
import {
  ThreadScrollFollowProvider,
  useThreadFollowScrollerRef,
  useThreadScrollFollow,
} from '../thread-scroll-follow';
import '@brainstrike/ui/globals.css';
import '../overrides.css';

/**
 * BST-1039: dispatching a queued follow-up must not unpin stick-to-bottom.
 *
 * The failure this pins (observed live in the web assistant-state E2E while
 * diagnosing BST-1036): while the thread is pinned, the queue chip row sits in
 * the composer area BELOW the viewport. When the run ends, the queue
 * dispatches the queued message and the chip row unmounts in the same breath —
 * the viewport gets taller, the browser clamps `scrollTop` down, and the
 * follow engine's scroll bookkeeping (thread-scroll-follow.tsx) could read
 * that clamp as a user scroll: `isAtBottom` flips false with no user act, the
 * reply streams below the fold, and the jump chip appears unprompted.
 *
 * The harness mirrors the panel's real geometry dependency: a fixed-height
 * column where the REAL `FollowUpQueueChips` share the column with the
 * viewport, so chip mount/unmount resizes the viewport exactly as the real
 * composer does. The run is held open by a deferred adapter so the enqueue
 * happens mid-run and the dispatch fires on the real run-end transition via
 * assistant-ui's own queue (`unstable_enableMessageQueue`).
 */

const MESSAGE_HEIGHT_PX = 90;
const MESSAGE_COUNT = 12;
const COLUMN_HEIGHT_PX = 320;

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
    style={{ flexShrink: 0, height: MESSAGE_HEIGHT_PX }}
  />
);

/**
 * Streaming stand-in: height tracks the streamed text so each chunk produces a
 * REAL content resize — that is what keeps the library re-sticking while
 * pinned in production, and the harness needs the same signal.
 */
const GrowingAssistantMessage = () => {
  const text = useAuiState((s) =>
    s.message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  );
  // Real text nodes, not a style height: the library's content observer
  // deliberately ignores style-attribute mutations, so growth must arrive the
  // way streaming text does — as character data.
  return (
    <div
      className="bs-scroll-test-message"
      data-testid="thread-message"
      style={{ flexShrink: 0, lineHeight: '20px', minHeight: MESSAGE_HEIGHT_PX }}
    >
      {text}
    </div>
  );
};

type RunEvent = 'chunk' | 'end';

/**
 * Streaming runs driven by the test: each `pushChunk` grows the assistant
 * message (a real content-resize, which is what keeps the library re-sticking
 * while pinned — production runs stream constantly), and `endOldestRun`
 * completes the run so `thread.isRunning` transitions on demand.
 */
function createDeferredAdapter() {
  const queues: Array<{ events: RunEvent[]; wake: (() => void) | null }> = [];
  const nextEvent = (queue: { events: RunEvent[]; wake: (() => void) | null }): Promise<RunEvent> =>
    new Promise((resolve) => {
      const dispatch = () => {
        const event = queue.events.shift();
        if (event) {
          resolve(event);
          return true;
        }
        return false;
      };
      if (!dispatch()) {
        queue.wake = () => {
          if (dispatch()) {
            queue.wake = null;
          }
        };
      }
    });
  const adapter: ChatModelAdapter = {
    async *run() {
      const queue: { events: RunEvent[]; wake: (() => void) | null } = { events: [], wake: null };
      queues.push(queue);
      let text = '';
      for (;;) {
        const event = await nextEvent(queue);
        if (event === 'end') {
          yield {
            content: [{ text, type: 'text' as const }],
            status: { reason: 'stop' as const, type: 'complete' as const },
          };
          return;
        }
        text = `${text}${'streamed-chunk-text '.repeat(8)}`;
        yield { content: [{ text, type: 'text' as const }] };
      }
    },
  };
  const push = (event: RunEvent) => {
    const queue = queues.at(-1);
    if (!queue) {
      throw new Error('No active run');
    }
    queue.events.push(event);
    queue.wake?.();
  };
  return {
    adapter,
    endNewestRun: () => push('end'),
    pushChunk: () => push('chunk'),
  };
}

/**
 * The follow engine's `scrollToBottom` request event fires ONLY for explicit
 * requests (the jump button, or product code asking to pin) — the engine's
 * internal follow writes never route through it. Recording its events lets
 * the tests assert the dispatch re-pin as behavior, not implementation.
 */
const scrollToBottomRequests: Record<string, never>[] = [];

function ScrollRequestProbe() {
  const follow = useThreadScrollFollow();
  useEffect(
    () =>
      follow.onScrollToBottom(() => {
        scrollToBottomRequests.push({});
      }),
    [follow]
  );
  return null;
}

/** Queues a follow-up through the composer, as the composer's Queue control does. */
function QueueFollowUpButton() {
  const aui = useAui();
  return (
    <button
      data-testid="queue-follow-up"
      onClick={() => {
        aui.composer().setText('queued follow-up');
        aui.composer().send({ steer: false });
      }}
      type="button"
    >
      queue
    </button>
  );
}

function StartRunButton() {
  const aui = useAui();
  return (
    <button
      data-testid="start-run"
      onClick={() => aui.thread().append({ content: [{ text: 'go', type: 'text' }], role: 'user' })}
      type="button"
    >
      start
    </button>
  );
}

function ScrollerWithFollow({ children }: { children: React.ReactNode }) {
  const scrollerRef = useThreadFollowScrollerRef();
  return (
    <div className="aui-thread-viewport" data-testid="assistant-ui-viewport" ref={scrollerRef}>
      {children}
    </div>
  );
}

function RepinHarness({ adapter }: { adapter: ChatModelAdapter }) {
  // assistant-ui's own queue, as the committed runtime provides one.
  const runtime = useLocalRuntime(adapter, { initialMessages, unstable_enableMessageQueue: true });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadScrollFollowProvider>
        <StartRunButton />
        <QueueFollowUpButton />
        <ScrollRequestProbe />
        <div className="assistant-ui-panel">
          <div
            className="bs-thread"
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: COLUMN_HEIGHT_PX,
              width: 420,
            }}
          >
            <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <ThreadScrollRegion>
                <ScrollerWithFollow>
                  <ThreadPrimitive.Messages
                    components={{
                      AssistantMessage: GrowingAssistantMessage,
                      UserMessage: TallMessage,
                    }}
                  />
                </ScrollerWithFollow>
                <ThreadScrollToBottom />
              </ThreadScrollRegion>
            </div>
            {/* The real chip row: mounting/unmounting it resizes the viewport,
                exactly like the panel's composer area. */}
            <FollowUpQueueChips />
          </div>
        </div>
      </ThreadScrollFollowProvider>
    </AssistantRuntimeProvider>
  );
}

const getViewport = (): HTMLElement => screen.getByTestId('assistant-ui-viewport');
const getButton = (): HTMLButtonElement =>
  screen.getByTestId('assistant-scroll-to-bottom') as HTMLButtonElement;

const distanceFromBottom = (el: HTMLElement): number =>
  Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight);

const dispatchRunEvent = async (dispatch: () => void): Promise<void> => {
  await act(async () => {
    dispatch();
  });
};

const enqueueFollowUp = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('queue-follow-up'));
  });
};

const waitForPinnedThread = async (): Promise<HTMLElement> => {
  await screen.findAllByTestId('thread-message');
  const viewport = getViewport();
  await waitFor(() => {
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight + 1);
    expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
  });
  return viewport;
};

afterEach(() => {
  cleanup();
  scrollToBottomRequests.length = 0;
  document.body.replaceChildren();
});

describe('follow-up queue dispatch keeps stick-to-bottom pinned (BST-1039)', () => {
  test('queue flush at run end does not unpin a bottom-pinned thread', async () => {
    const { adapter, endNewestRun, pushChunk } = createDeferredAdapter();
    render(<RepinHarness adapter={adapter} />);
    const viewport = await waitForPinnedThread();

    // Start a run and hold it open: the appended user message adds a row.
    fireEvent.click(screen.getByTestId('start-run'));
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-message').length).toBeGreaterThan(MESSAGE_COUNT);
    });
    await dispatchRunEvent(pushChunk);

    // Queue a follow-up mid-run: the REAL chip row mounts below the viewport,
    // shrinking it. A streaming chunk lands right after — production runs
    // stream constantly, and the content-resize is what re-sticks the library
    // after the shrink. Pinned follow survives this direction.
    await enqueueFollowUp();
    await screen.findByTestId('assistant-follow-up-chip');
    await dispatchRunEvent(pushChunk);
    await waitFor(() => {
      expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
    });

    // End the run: the bridge dispatches the queued message, the chip row
    // unmounts (viewport grows, browser clamps scrollTop), and the dispatched
    // run's content appends — the exact window that unpinned follow. A
    // pinned-at-dispatch flush must request an explicit scroll-to-bottom:
    // dispatch IS a send, and the explicit request arms the library's
    // in-flight-scroll bookkeeping through the clamp window.
    scrollToBottomRequests.length = 0;
    await dispatchRunEvent(endNewestRun);
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-follow-up-chip')).not.toBeInTheDocument();
    });
    expect(scrollToBottomRequests.length).toBeGreaterThan(0);
    // The dispatched follow-up starts its own run — wait for its user row
    // (12 initial + "go" + reply + the dispatched message) so the adapter has
    // registered the run, then stream and finish it. No side effects inside
    // waitFor: the callback may run any number of times.
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-message').length).toBeGreaterThan(MESSAGE_COUNT + 2);
    });
    await dispatchRunEvent(pushChunk);
    await dispatchRunEvent(endNewestRun);

    // The thread was pinned before the flush and the user never scrolled:
    // follow must still be engaged once the dust settles — bottom-pinned
    // viewport, jump affordance disabled.
    await waitFor(
      () => {
        expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
        expect(getButton()).toBeDisabled();
      },
      { timeout: 5000 }
    );
    // And it STAYS pinned (the failure mode froze scrollTop while content
    // kept growing — give any late clamp a beat to surface).
    await new Promise((resolvePause) => setTimeout(resolvePause, 300));
    expect(distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
    expect(getButton()).toBeDisabled();
  });

  test('dispatch never yanks a reader who scrolled up while the run streamed', async () => {
    const { adapter, endNewestRun, pushChunk } = createDeferredAdapter();
    render(<RepinHarness adapter={adapter} />);
    const viewport = await waitForPinnedThread();

    fireEvent.click(screen.getByTestId('start-run'));
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-message').length).toBeGreaterThan(MESSAGE_COUNT);
    });
    await dispatchRunEvent(pushChunk);
    await enqueueFollowUp();
    await screen.findByTestId('assistant-follow-up-chip');

    // The reader scrolls up mid-run: follow disengages by design.
    viewport.scrollTo({ behavior: 'instant', top: 0 });
    await waitFor(() => {
      expect(getButton()).toBeEnabled();
    });

    scrollToBottomRequests.length = 0;
    await dispatchRunEvent(endNewestRun);
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-follow-up-chip')).not.toBeInTheDocument();
    });
    // The dispatched follow-up starts its own run — wait for its user row
    // (12 initial + "go" + reply + the dispatched message) so the adapter has
    // registered the run, then stream and finish it. No side effects inside
    // waitFor: the callback may run any number of times.
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-message').length).toBeGreaterThan(MESSAGE_COUNT + 2);
    });
    await dispatchRunEvent(pushChunk);
    await dispatchRunEvent(endNewestRun);

    // No explicit scroll request, reading position untouched, affordance kept.
    await new Promise((resolvePause) => setTimeout(resolvePause, 300));
    expect(scrollToBottomRequests.length).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    expect(getButton()).toBeEnabled();
  });
});
