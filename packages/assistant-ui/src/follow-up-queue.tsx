/**
 * Follow-up message queue UI + dispatch (report R3 v1; the queue half of
 * mastra-code's steer/followUp pair — steering is a later, loop-level stage).
 *
 * Three pieces, all keyed by the panel's `threadKey`:
 *  - `QueueFollowUpButton` — rendered in the composer's RUNNING branch (where
 *    Send is unmounted): takes the current draft, enqueues it, clears the
 *    composer. Never a form submit (type="button") so it cannot trip the
 *    composer root's onSubmitCapture run-start seam.
 *  - `FollowUpQueueChips` — visible, removable "queued" chips above the
 *    composer; a removed chip is never dispatched.
 *  - `FollowUpQueueBridge` — render-nothing leaf (mounted alongside
 *    `RunLifecycleNotificationBridge`) that joins the runtime's
 *    `thread.runEnd` event and dispatches ONE queued message per run end via
 *    `aui.thread().append(...)` (the same programmatic-send seam the approval
 *    and suspend notices use). FIFO: the next item waits for the dispatched
 *    run to end. Dispatch failures are re-queued at the FRONT and logged —
 *    never silently dropped.
 *
 * The run end is the runtime's event, never an observed `isRunning` edge:
 * thread state reaches React through batched renders, so a dispatched run
 * that starts and ends between two renders never shows as running, and an
 * edge-watching bridge would strand the rest of the queue (BST-2207). The
 * rendered `isRunning` only gates the send — nothing is appended while a run
 * is visibly active.
 *
 * Hydration/thread-switch guards mirror run-lifecycle-notifications.ts: no
 * dispatch while `state.thread.isLoading` (a run end waits for the real
 * state), and a threadKey change discards any pending run end instead of
 * treating the switch as one. Dispatch fires on BOTH finished and
 * failed/cancelled runs (the event does not distinguish them); the chip's
 * remove control is the user's veto while the run is active.
 */
import { useAui, useAuiEvent, useAuiState } from '@assistant-ui/react';
import { createLogger } from '@brainstrike/logging';
import { ArrowUpIcon, CornerDownRightIcon, PencilIcon, XIcon, ZapIcon } from 'lucide-react';
import { use, useEffect, useRef, useState } from 'react';
import { useAnsweredApprovals } from './answered-approvals-context';
import { requestSteer, steerShortcutLabel, useComposerRunActions } from './composer-run-actions';
import { FollowUpQueueOwnershipContext } from './follow-up-queue-ownership';
import {
  dequeueDispatchable,
  followUpQueueKey,
  useFollowUpQueueStore,
} from './follow-up-queue-store';
import { type ThreadScrollFollow, useThreadScrollFollow } from './thread-scroll-follow';

const logger = createLogger('FollowUpQueue');

function canDispatchQueuedFollowUp(args: {
  readonly queueLength: number;
  readonly isRunEnd: boolean;
  readonly isCatchUp: boolean;
  readonly deferredRunEnd: boolean;
}): boolean {
  return args.queueLength > 0 && (args.isRunEnd || args.isCatchUp || args.deferredRunEnd);
}

/** Sends the queue's next dispatchable item as a real user message. */
function sendNextQueuedFollowUp({
  answered,
  aui,
  follow,
  queueKey,
}: {
  readonly answered: ReadonlyMap<string, unknown>;
  readonly aui: ReturnType<typeof useAui>;
  readonly follow: ThreadScrollFollow;
  readonly queueKey: string;
}): void {
  const item = dequeueDispatchable(queueKey, answered);
  if (!item) {
    return;
  }
  // `append` is synchronous (returns void) in the installed assistant-ui;
  // the guard covers a synchronous throw from the runtime binding. A run
  // that STARTS and then fails is a normal run.failed, not a dispatch
  // failure — it is not requeued.
  const wasPinned = follow.getIsAtBottom();
  try {
    aui.thread().append(
      item.message ?? {
        content: [{ text: item.text, type: 'text' }],
        role: 'user',
      }
    );
  } catch (error) {
    useFollowUpQueueStore.getState().requeueFront(queueKey, item);
    logger.warn('Failed to dispatch queued follow-up; requeued at front', { error });
    return;
  }
  if (wasPinned) {
    // Dispatch IS a send, and sending pins the thread. Beyond intent,
    // this closes a real race (BST-1039): the dequeue above unmounts the
    // chip row, the composer shrinks, and the browser's scrollTop clamp
    // can be misread as a user scroll by the follow engine's scroll
    // bookkeeping — silently unpinning follow with no user act. The
    // explicit request re-arms that bookkeeping through the clamp window.
    // Readers who scrolled up are never yanked: wasPinned is captured
    // before the flush. OUTSIDE the try: a scroll failure must never
    // requeue an already-sent message (duplicate send). No behavior
    // option — the engine's scrollToBottom deliberately omits it, so the
    // default routes through CSS scroll-behavior (see THREAD SCROLLING in
    // docs/agents/assistant-runtime.md).
    follow.scrollToBottom();
  }
}

function useFollowUpQueueDispatch(threadKey: string | undefined, isReattaching = false): void {
  const ownsQueue = use(FollowUpQueueOwnershipContext);
  const aui = useAui();
  const follow = useThreadScrollFollow();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const isHistoryLoading = useAuiState((state) => state.thread.isLoading);
  const { answers: answered } = useAnsweredApprovals();
  const queueKey = followUpQueueKey(threadKey);
  const queueLength = useFollowUpQueueStore((state) => state.queuedByThread[queueKey]?.length ?? 0);
  // Every run end the runtime reports, counted from its own event (see the
  // module header). The effect serves the ones it has not handled yet.
  const [runEnds, setRunEnds] = useState(0);
  useAuiEvent('thread.runEnd', () => {
    setRunEnds((count) => count + 1);
  });

  const handledRunEndsRef = useRef(runEnds);
  const seededKeyRef = useRef(queueKey);
  // The bridge lives inside a threadKey-keyed subtree, so a thread switch
  // UNMOUNTS it — a run that ends off-screen reaches no listener. Once per
  // (re)mounted key, an IDLE thread with a non-empty queue is treated as
  // exactly that missed run end and dispatched (the chip promised "sends when
  // the current run ends"; the run HAS ended). false until the first settled
  // (non-loading) observation.
  const caughtUpKeyRef = useRef<string | undefined>(undefined);
  const deferredRunEndRef = useRef(false);

  useEffect(() => {
    if (!ownsQueue) {
      return;
    }
    if (seededKeyRef.current !== queueKey) {
      // Thread switch WITHIN one mounted bridge: a switch is not a run end,
      // so drop any pending one, and let the catch-up below re-evaluate for
      // the new key.
      seededKeyRef.current = queueKey;
      handledRunEndsRef.current = runEnds;
      caughtUpKeyRef.current = undefined;
      deferredRunEndRef.current = false;
      return;
    }
    if (isHistoryLoading) {
      // Reload hydration; defer any observation until the real state is in.
      return;
    }
    const isCatchUp = caughtUpKeyRef.current !== queueKey;
    caughtUpKeyRef.current = queueKey;
    if (isRunning) {
      // A run is on screen: still going, or its end has not rendered yet.
      // Either way nothing is sent over it; a pending run end waits here.
      return;
    }
    const isRunEnd = handledRunEndsRef.current !== runEnds;
    handledRunEndsRef.current = runEnds;
    // The renderer can briefly report idle after a socket drops even while
    // the host run remains active. Keep the chip until replay reaches a real
    // terminal result (or the stale cursor is explicitly released).
    if (isReattaching) {
      deferredRunEndRef.current ||= queueLength > 0 && (isRunEnd || isCatchUp);
      return;
    }
    if (
      !canDispatchQueuedFollowUp({
        deferredRunEnd: deferredRunEndRef.current,
        isCatchUp,
        isRunEnd,
        queueLength,
      })
    ) {
      return;
    }
    deferredRunEndRef.current = false;
    sendNextQueuedFollowUp({ answered, aui, follow, queueKey });
  }, [
    answered,
    aui,
    follow,
    isHistoryLoading,
    isReattaching,
    isRunning,
    ownsQueue,
    queueKey,
    queueLength,
    runEnds,
  ]);
}

/** Render-nothing leaf owning the run-end dispatch subscription. */
export function FollowUpQueueBridge({
  isReattaching,
  threadKey,
}: {
  readonly isReattaching?: boolean;
  readonly threadKey?: string | undefined;
}) {
  useFollowUpQueueDispatch(threadKey, isReattaching);
  return null;
}

/**
 * The running-branch primary action: queue the current draft for dispatch
 * after this run (Enter does the same). Disabled for whitespace-only drafts
 * (the store would refuse them anyway — this keeps the refusal out of reach
 * instead of throwing).
 */
export function QueueFollowUpButton({ threadKey }: { readonly threadKey?: string | undefined }) {
  const actions = useComposerRunActions({ threadKey });
  const canQueue = useAuiState((state) => state.composer.text.trim().length > 0);
  if (!actions) {
    return null;
  }
  return (
    <button
      aria-keyshortcuts="Enter"
      aria-label="Queue message to send after this run"
      className="aui-composer-send bs-composer-queue"
      data-testid="assistant-queue-follow-up"
      disabled={!canQueue}
      onClick={actions.queue}
      title="Queue: sends after this run (Enter)"
      type="button"
    >
      <ArrowUpIcon aria-hidden="true" />
    </button>
  );
}

/**
 * Mid-run steering (BST-588): sends the draft now. It joins the FRONT of the
 * follow-up queue (the user interrupted the run FOR this message), then asks
 * the server to end the run gracefully at the next step boundary. Absent a
 * transport the button is not rendered — capability-gated, never stubbed.
 */
export function SteerRunButton({
  onSteerRequest,
  threadKey,
}: {
  readonly onSteerRequest: () => Promise<boolean>;
  readonly threadKey?: string | undefined;
}) {
  const actions = useComposerRunActions({ onSteerActiveRun: onSteerRequest, threadKey });
  const canSteer = useAuiState((state) => state.composer.text.trim().length > 0);
  if (!actions?.steer) {
    return null;
  }
  const shortcut = steerShortcutLabel();
  return (
    <button
      aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"
      aria-label="Steer: send now, stopping the run at the next step"
      className="bs-composer-chip bs-composer-steer"
      data-testid="assistant-steer-run"
      disabled={!canSteer}
      onClick={actions.steer}
      title={`Steer: send now, stopping the run after its current step (${shortcut})`}
      type="button"
    >
      <ZapIcon aria-hidden="true" />
      <span>Steer</span>
      <kbd className="bs-composer-kbd">{shortcut}</kbd>
    </button>
  );
}

/**
 * The composer's complete RUNNING-branch control cluster: Steer when the app
 * shell supplied a transport (BST-588), then Queue. Extracted so the panel
 * root stays a one-line composition site.
 */
export function ComposerRunControls({
  onSteerActiveRun,
  threadKey,
}: {
  readonly onSteerActiveRun?: (() => Promise<boolean>) | undefined;
  readonly threadKey?: string | undefined;
}) {
  const ownsQueue = use(FollowUpQueueOwnershipContext);
  if (!ownsQueue) {
    return null;
  }
  return (
    <>
      {onSteerActiveRun ? (
        <SteerRunButton onSteerRequest={onSteerActiveRun} threadKey={threadKey} />
      ) : null}
      <QueueFollowUpButton threadKey={threadKey} />
    </>
  );
}

/**
 * The queued messages, stacked on the composer's top edge in send order. Each
 * row can be steered (sent next, ending the run after its current step), pulled
 * back into an empty composer to edit, or removed; a removed row is never
 * dispatched. Queued tool decisions carry a prepared message, so they can be
 * steered or removed but not edited as text. Hidden when nothing is queued.
 */
export function FollowUpQueueChips({
  onSteerActiveRun,
  threadKey,
}: {
  readonly onSteerActiveRun?: (() => Promise<boolean>) | undefined;
  readonly threadKey?: string | undefined;
}) {
  const ownsQueue = use(FollowUpQueueOwnershipContext);
  const aui = useAui();
  const queueKey = followUpQueueKey(threadKey);
  const items = useFollowUpQueueStore((state) => state.queuedByThread[queueKey]);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const draftIsEmpty = useAuiState(
    (state) => state.composer.text.trim().length === 0 && state.composer.attachments.length === 0
  );

  if (!(ownsQueue && items?.length)) {
    return null;
  }
  const store = useFollowUpQueueStore.getState;
  return (
    <ol
      aria-label="Queued follow-up messages"
      className="bs-composer-queue-list"
      data-testid="assistant-follow-up-queue"
    >
      {items.map((item) => (
        <li
          className="bs-composer-queue-item"
          data-testid="assistant-follow-up-chip"
          key={item.id}
          title={`Queued: sends when the current run ends — ${item.text}`}
        >
          <CornerDownRightIcon aria-hidden="true" className="bs-composer-queue-glyph" />
          <span className="bs-composer-queue-text">{item.text}</span>
          {onSteerActiveRun && isRunning ? (
            <button
              aria-label={`Steer now: ${item.text}`}
              className="bs-composer-chip"
              data-testid="assistant-follow-up-chip-steer"
              onClick={() => {
                store().promote(queueKey, item.id);
                requestSteer(onSteerActiveRun);
              }}
              title="Send now: stops the run after its current step"
              type="button"
            >
              <ZapIcon aria-hidden="true" />
              <span>Steer</span>
            </button>
          ) : null}
          {item.message === undefined ? (
            <button
              aria-label={`Edit queued message: ${item.text}`}
              className="bs-composer-icon-button bs-composer-icon-button-sm"
              data-testid="assistant-follow-up-chip-edit"
              disabled={!draftIsEmpty}
              onClick={(event) => {
                store().remove(queueKey, item.id);
                aui.composer().setText(item.text);
                // The row unmounts with its button: hand focus to the input
                // that now holds the text.
                event.currentTarget
                  .closest('.bs-composer-shell')
                  ?.querySelector<HTMLElement>('.aui-composer-input')
                  ?.focus();
              }}
              title={draftIsEmpty ? 'Edit in the composer' : 'Send or clear your draft to edit'}
              type="button"
            >
              <PencilIcon aria-hidden="true" />
            </button>
          ) : null}
          <button
            aria-label="Remove queued message"
            className="bs-composer-icon-button bs-composer-icon-button-sm"
            data-testid="assistant-follow-up-chip-remove"
            onClick={() => store().remove(queueKey, item.id)}
            title="Remove from the queue"
            type="button"
          >
            <XIcon aria-hidden="true" />
          </button>
        </li>
      ))}
    </ol>
  );
}
