/**
 * The composer's queue controls, over assistant-ui's own message queue
 * (`thread-message-queue.ts`, bound by the committed runtime):
 *  - `QueueFollowUpButton` / `SteerRunButton` — the running-branch actions
 *    (`composer-run-actions.ts`). Never form submits (type="button"), so they
 *    cannot trip the composer root's onSubmitCapture run-start seam.
 *  - `FollowUpQueueChips` — the waiting messages, rendered with
 *    `ComposerPrimitive.Queue` / `QueueItemPrimitive`, in send order.
 *  - `QueuedDecisionPruner` — drops a queued tool decision once the host has
 *    answered its pause, so it is never sent.
 *
 * All of them render only while the thread offers a queue, which the
 * committed runtime does during a run or while messages wait.
 */
import { ComposerPrimitive, QueueItemPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import {
  ArrowUpIcon,
  CornerDownRightIcon,
  PencilIcon,
  SendIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { useAnsweredApprovals } from './answered-approvals-context';
import { requestSteer, steerShortcutLabel, useComposerRunActions } from './composer-run-actions';
import { findThreadMessageQueue } from './thread-message-queue';
import { useThreadScrollFollow } from './thread-scroll-follow';

/** Render-nothing leaf: a decision the host answered meanwhile leaves the queue. */
export function QueuedDecisionPruner({ threadKey }: { readonly threadKey?: string | undefined }) {
  const { answers } = useAnsweredApprovals();
  useEffect(() => {
    findThreadMessageQueue(threadKey)?.dropAnswered(answers);
  }, [answers, threadKey]);
  return null;
}

/**
 * The running-branch primary action: queue the current draft for dispatch
 * after this run (Enter does the same). Disabled for an empty draft.
 */
export function QueueFollowUpButton() {
  const actions = useComposerRunActions({});
  const canQueue = useAuiState((state) => state.composer.canSend && !state.composer.isEmpty);
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
 * Mid-run steering (BST-588): the draft goes first in line and the server is
 * asked to end the run gracefully at the next step boundary. Absent a
 * transport the button is not rendered — capability-gated, never stubbed.
 */
export function SteerRunButton({
  onSteerRequest,
}: {
  readonly onSteerRequest: () => Promise<boolean>;
}) {
  const actions = useComposerRunActions({ onSteerActiveRun: onSteerRequest });
  const canSteer = useAuiState((state) => state.composer.canSend && !state.composer.isEmpty);
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
 * shell supplied a transport (BST-588), then Queue.
 */
export function ComposerRunControls({
  onSteerActiveRun,
}: {
  readonly onSteerActiveRun?: (() => Promise<boolean>) | undefined;
}) {
  return (
    <>
      {onSteerActiveRun ? <SteerRunButton onSteerRequest={onSteerActiveRun} /> : null}
      <QueueFollowUpButton />
    </>
  );
}

/**
 * Sending pins the thread, and a dispatch is a send. Beyond intent this closes
 * a real race (BST-1039): the sent row unmounts, the composer shrinks, and the
 * browser's scrollTop clamp can be misread as a user scroll by the follow
 * engine's bookkeeping — silently unpinning follow with no user act. The
 * queue's own state change is read before React commits the unmount, so a
 * reader who scrolled up is never yanked. No behavior option: the engine's
 * default routes through CSS scroll-behavior (THREAD SCROLLING in
 * docs/agents/assistant-runtime.md).
 */
function useRepinWhenQueueShrinks(): void {
  const aui = useAui();
  const follow = useThreadScrollFollow();
  useEffect(() => {
    let count = aui.composer().getState().queue.length;
    return aui.subscribe(() => {
      const next = aui.composer().getState().queue.length;
      if (next < count && follow.getIsAtBottom()) {
        follow.scrollToBottom();
      }
      count = next;
    });
  }, [aui, follow]);
}

/**
 * The waiting messages, stacked on the composer's top edge in send order. Each
 * row can be steered during a run (sent next, ending the run after its current
 * step), sent now when no run is active (after a Stop the queue waits for the
 * user), pulled back into an empty composer to edit, or removed; a removed row
 * is never sent. Queued tool decisions and messages with images can be sent
 * or removed but not edited as text.
 */
export function FollowUpQueueChips({
  onSteerActiveRun,
  threadKey,
}: {
  readonly onSteerActiveRun?: (() => Promise<boolean>) | undefined;
  readonly threadKey?: string | undefined;
}) {
  const count = useAuiState((state) => state.composer.queue.length);
  useRepinWhenQueueShrinks();
  if (count === 0) {
    return null;
  }
  return (
    <ol
      aria-label="Queued follow-up messages"
      className="bs-composer-queue-list"
      data-testid="assistant-follow-up-queue"
    >
      <ComposerPrimitive.Queue>
        {({ queueItem }) => (
          <QueuedRow
            itemId={queueItem.id}
            onSteerActiveRun={onSteerActiveRun}
            prompt={queueItem.prompt}
            textOnly={queueItem.parts.every((part) => part.type === 'text')}
            threadKey={threadKey}
          />
        )}
      </ComposerPrimitive.Queue>
    </ol>
  );
}

function QueuedRow({
  itemId,
  onSteerActiveRun,
  prompt,
  textOnly,
  threadKey,
}: {
  readonly itemId: string;
  readonly onSteerActiveRun: (() => Promise<boolean>) | undefined;
  readonly prompt: string;
  readonly textOnly: boolean;
  readonly threadKey: string | undefined;
}) {
  const aui = useAui();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const draftIsEmpty = useAuiState((state) => state.composer.isEmpty);
  const queue = findThreadMessageQueue(threadKey);
  const editable = textOnly && !queue?.isDecision(itemId);
  return (
    <li
      className="bs-composer-queue-item"
      data-testid="assistant-follow-up-chip"
      title={`Queued: sends when the current run ends — ${prompt}`}
    >
      <CornerDownRightIcon aria-hidden="true" className="bs-composer-queue-glyph" />
      <QueueItemPrimitive.Text className="bs-composer-queue-text" />
      {isRunning && onSteerActiveRun ? (
        <QueueItemPrimitive.Steer
          aria-label={`Steer now: ${prompt}`}
          className="bs-composer-chip"
          data-testid="assistant-follow-up-chip-steer"
          onClick={() => requestSteer(onSteerActiveRun)}
          title="Send now: stops the run after its current step"
          type="button"
        >
          <ZapIcon aria-hidden="true" />
          <span>Steer</span>
        </QueueItemPrimitive.Steer>
      ) : null}
      {!isRunning && queue ? (
        <button
          aria-label={`Send now: ${prompt}`}
          className="bs-composer-chip"
          data-testid="assistant-follow-up-chip-send"
          onClick={() => queue.sendNow(itemId)}
          title="Send now"
          type="button"
        >
          <SendIcon aria-hidden="true" />
          <span>Send</span>
        </button>
      ) : null}
      {editable ? (
        <button
          aria-label={`Edit queued message: ${prompt}`}
          className="bs-composer-icon-button bs-composer-icon-button-sm"
          data-testid="assistant-follow-up-chip-edit"
          disabled={!draftIsEmpty}
          onClick={(event) => {
            // The row unmounts with its button: hand focus to the input that
            // now holds the text.
            const input = event.currentTarget
              .closest('.bs-composer-shell')
              ?.querySelector<HTMLElement>('.aui-composer-input');
            aui.queueItem.remove();
            aui.composer().setText(prompt);
            input?.focus();
          }}
          title={draftIsEmpty ? 'Edit in the composer' : 'Send or clear your draft to edit'}
          type="button"
        >
          <PencilIcon aria-hidden="true" />
        </button>
      ) : null}
      <QueueItemPrimitive.Remove
        aria-label="Remove queued message"
        className="bs-composer-icon-button bs-composer-icon-button-sm"
        data-testid="assistant-follow-up-chip-remove"
        title="Remove from the queue"
        type="button"
      >
        <XIcon aria-hidden="true" />
      </QueueItemPrimitive.Remove>
    </li>
  );
}
