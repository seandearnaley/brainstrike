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
 *    `RunLifecycleNotificationBridge`) that watches the thread's isRunning
 *    transition true->false and dispatches ONE queued message per run end via
 *    `aui.thread().append(...)` (the same programmatic-send seam the approval
 *    and suspend notices use). FIFO: the next item waits for the dispatched
 *    run to end. Dispatch failures are re-queued at the FRONT and logged —
 *    never silently dropped.
 *
 * Hydration/thread-switch guards mirror run-lifecycle-notifications.ts: no
 * dispatch while `state.thread.isLoading` (reload hydration must not replay a
 * "run end"), and a threadKey change reseeds the transition baseline instead
 * of treating the switch as a run end. Dispatch fires on BOTH finished and
 * failed/cancelled runs (a transition-based seam cannot distinguish them);
 * the chip's remove control is the user's veto while the run is active.
 */
import { useAui, useAuiState } from '@assistant-ui/react';
import { createLogger } from '@brainstrike/logging';
import { ListPlusIcon, Redo2Icon, XIcon } from 'lucide-react';
import { use, useEffect, useRef } from 'react';
import { FollowUpQueueOwnershipContext } from './follow-up-queue-ownership';
import { followUpQueueKey, useFollowUpQueueStore } from './follow-up-queue-store';
import { useThreadScrollFollow } from './thread-scroll-follow';

const logger = createLogger('FollowUpQueue');

export function useFollowUpQueueDispatch(threadKey: string | undefined): void {
  const ownsQueue = use(FollowUpQueueOwnershipContext);
  const aui = useAui();
  const follow = useThreadScrollFollow();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const isHistoryLoading = useAuiState((state) => state.thread.isLoading);
  const queueKey = followUpQueueKey(threadKey);
  const queueLength = useFollowUpQueueStore((state) => state.queuedByThread[queueKey]?.length ?? 0);

  const wasRunningRef = useRef(false);
  const seededKeyRef = useRef(queueKey);
  // The bridge lives inside a threadKey-keyed subtree, so a thread switch
  // UNMOUNTS it — a run that ends off-screen produces no observable
  // transition. Once per (re)mounted key, an IDLE thread with a non-empty
  // queue is treated as exactly that missed run end and dispatched (the chip
  // promised "sends when the current run ends"; the run HAS ended). false
  // until the first settled (non-loading) observation.
  const caughtUpKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!ownsQueue) {
      return;
    }
    if (seededKeyRef.current !== queueKey) {
      // Thread switch WITHIN one mounted bridge: reseed the baseline from the
      // NEW thread's live state — a switch is not a run end — and let the
      // catch-up below re-evaluate for the new key.
      seededKeyRef.current = queueKey;
      wasRunningRef.current = isRunning;
      caughtUpKeyRef.current = undefined;
      return;
    }
    if (isHistoryLoading) {
      // Reload hydration; defer any observation until the real state is in.
      return;
    }
    const isCatchUp = caughtUpKeyRef.current !== queueKey;
    caughtUpKeyRef.current = queueKey;
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = isRunning;
    const isRunEndTransition = wasRunning && !isRunning;
    if (isRunning || queueLength === 0 || !(isRunEndTransition || isCatchUp)) {
      return;
    }

    const item = useFollowUpQueueStore.getState().dequeue(queueKey);
    if (!item) {
      return;
    }
    // `append` is synchronous (returns void) in the installed assistant-ui;
    // the guard covers a synchronous throw from the runtime binding. A run
    // that STARTS and then fails is a normal run.failed, not a dispatch
    // failure — it is not requeued.
    const wasPinned = follow.getIsAtBottom();
    try {
      aui.thread().append({
        content: [{ text: item.text, type: 'text' }],
        role: 'user',
      });
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
  }, [aui, follow, isHistoryLoading, isRunning, ownsQueue, queueKey, queueLength]);
}

/** Render-nothing leaf owning the run-end dispatch subscription. */
export function FollowUpQueueBridge({ threadKey }: { readonly threadKey?: string | undefined }) {
  useFollowUpQueueDispatch(threadKey);
  return null;
}

/**
 * The running-branch composer control: queue the current draft for dispatch
 * after this run. Disabled for whitespace-only drafts (the store would refuse
 * them anyway — this keeps the refusal out of reach instead of throwing).
 */
export function QueueFollowUpButton({ threadKey }: { readonly threadKey?: string | undefined }) {
  const aui = useAui();
  const draft = useAuiState((state) => state.composer.text);
  const enqueue = useFollowUpQueueStore((state) => state.enqueue);
  const canQueue = draft.trim().length > 0;

  return (
    <button
      aria-label="Queue message to send after this run"
      className="aui-button aui-button-primary aui-composer-send"
      data-testid="assistant-queue-follow-up"
      disabled={!canQueue}
      onClick={() => {
        enqueue(followUpQueueKey(threadKey), draft);
        aui.composer().setText('');
      }}
      title="Queue message to send after this run"
      type="button"
    >
      <ListPlusIcon className="size-4" />
    </button>
  );
}

/**
 * Mid-run steering (BST-588): the composer's RUNNING-branch "Steer now"
 * control. Enqueues the draft at the FRONT of the follow-up queue (the user
 * interrupted the run FOR this message), then asks the server to end the run
 * gracefully at the next step boundary via `onSteerRequest` (the app shell
 * supplies the transport; absence of the prop = steering unavailable, so the
 * panel simply does not render this button — capability-gated, never stubbed).
 * A failed control request never loses the message: it stays queued and
 * dispatches whenever the run ends naturally.
 */
export function SteerRunButton({
  onSteerRequest,
  threadKey,
}: {
  readonly onSteerRequest: () => Promise<boolean>;
  readonly threadKey?: string | undefined;
}) {
  const aui = useAui();
  const draft = useAuiState((state) => state.composer.text);
  const enqueueFront = useFollowUpQueueStore((state) => state.enqueueFront);
  // Double-click guard (review P3): both clicks of a fast double-click see the
  // same rendered draft, so without this a steer front-enqueues twice.
  const steerInFlightRef = useRef(false);
  const canSteer = draft.trim().length > 0;

  return (
    <button
      aria-label="Steer: send now, stopping the run at the next step"
      className="aui-button aui-button-primary aui-composer-send"
      data-testid="assistant-steer-run"
      disabled={!canSteer}
      onClick={() => {
        if (steerInFlightRef.current) {
          return;
        }
        steerInFlightRef.current = true;
        enqueueFront(followUpQueueKey(threadKey), draft);
        aui.composer().setText('');
        onSteerRequest()
          .then((accepted) => {
            if (!accepted) {
              // The run already finished (404 from the control endpoint) — the
              // queued message dispatches via the normal run-end bridge.
              logger.info('Steer control found no active run; message stays queued');
            }
          })
          .catch((error: unknown) => {
            logger.warn('Steer control request failed; message stays queued', { error });
          });
      }}
      title="Steer: send now, stopping the run at the next step"
      type="button"
    >
      <Redo2Icon className="size-4" />
    </button>
  );
}

/**
 * The composer's complete RUNNING-branch control cluster: Queue always, Steer
 * only when the app shell supplied a transport (BST-588). Extracted so the
 * panel root stays a one-line composition site.
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
      <QueueFollowUpButton threadKey={threadKey} />
      {onSteerActiveRun ? (
        <SteerRunButton onSteerRequest={onSteerActiveRun} threadKey={threadKey} />
      ) : null}
    </>
  );
}

/** Removable "queued" chips above the composer; hidden when nothing is queued. */
export function FollowUpQueueChips({ threadKey }: { readonly threadKey?: string | undefined }) {
  const ownsQueue = use(FollowUpQueueOwnershipContext);
  const queueKey = followUpQueueKey(threadKey);
  const items = useFollowUpQueueStore((state) => state.queuedByThread[queueKey]);
  const remove = useFollowUpQueueStore((state) => state.remove);

  if (!(ownsQueue && items?.length)) {
    return null;
  }
  return (
    <ul
      aria-label="Queued follow-up messages"
      className="m-0 flex list-none flex-wrap gap-1.5 px-1 pb-0.5"
      data-testid="assistant-follow-up-queue"
    >
      {items.map((item) => (
        <li
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-muted-foreground text-xs"
          data-testid="assistant-follow-up-chip"
          key={item.id}
          title={`Queued: sends when the current run ends — ${item.text}`}
        >
          <span className="truncate">{item.text}</span>
          <button
            aria-label="Remove queued message"
            className="shrink-0 rounded-full p-0.5 hover:bg-background/60"
            data-testid="assistant-follow-up-chip-remove"
            onClick={() => remove(queueKey, item.id)}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
