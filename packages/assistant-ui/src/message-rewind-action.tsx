import { useAui, useAuiState } from '@assistant-ui/react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { History } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import { useRewindComposerStore } from './rewind-composer-store';
import { useRewindContext } from './rewind-context';

/**
 * THE COPY IS LOAD-BEARING (Amendment 2). A rewind is INCLUSIVE of its target:
 * this message and every later one are hidden, and the runs they triggered are
 * reverted. "Restore to here" reads as "keep this message" to roughly half of
 * readers, and the half that is wrong loses the prompt they were about to
 * re-send. Do not shorten this label.
 */
export const REWIND_ACTION_LABEL = 'Restore to before this message';

/**
 * The composer text a rewind of `role`/`text` should restore.
 *
 * Only a USER message has a prompt worth re-sending — Amendment 2's
 * rewind-and-retry loop is "put my prompt back so I can edit and send a
 * variant". An assistant message has no prompt, so it gets `null` rather than
 * its own prose pasted into the composer. Whitespace-only text is `null` too:
 * a composer repopulated with nothing is indistinguishable from the feature
 * silently failing.
 */
export function selectRewindComposerText(role: string, text: string): string | null {
  if (role !== 'user') {
    return null;
  }
  return text.trim() === '' ? null : text;
}

/**
 * "Restore to before this message" — the message-level entry point into
 * Conversation Rewind (BST-1115).
 *
 * Renders null when there is no `RewindProvider` binding (web, or a desktop
 * build without the `window.changes` bridge), when the active thread id is
 * unknown, when this is not a user message, or while a run is in flight —
 * capability gating and a safety gate, never a disabled stub. Rewinding out
 * from under a live run would revert files the run is still writing.
 *
 * Clicking only RAISES the confirm modal. The scope choice
 * (conversation-only vs conversation-and-files), the file preview, and the
 * conflict acknowledgment all live there; nothing here can write to disk.
 */
export function MessageRewindAction({
  threadId,
}: {
  readonly threadId: string | undefined;
}): ReactElement | null {
  const aui = useAui();
  const context = useRewindContext();
  const messageId = useAuiState((state) => state.message.id);
  const role = useAuiState((state) => state.message.role);
  const isRunning = useAuiState((state) => state.thread.isRunning);

  if (!(context && threadId && messageId) || role !== 'user' || isRunning) {
    return null;
  }

  const onClick = (): void => {
    context.requestRewind({
      composerText: selectRewindComposerText(role, aui.message().getCopyText()),
      messageId,
      threadId,
    });
  };

  return (
    <div className="col-start-2 row-start-4 mt-1 flex justify-end" data-testid="message-rewind-row">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={REWIND_ACTION_LABEL}
            className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
            data-testid="message-rewind-action"
            onClick={onClick}
            size="sm"
            variant="ghost"
          >
            <History aria-hidden="true" className="size-3" />
            {REWIND_ACTION_LABEL}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Hides this message and everything after it, and can restore the files those turns changed.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Render-nothing leaf that drains {@link useRewindComposerStore} into the live
 * composer. Mounted once per thread alongside the other bridges — the button
 * that raised the rewind is UNMOUNTED by the time the rewind succeeds (its
 * message is now hidden), so the consumer has to be something that outlives it.
 */
export function RewindComposerBridge(): null {
  const aui = useAui();
  const context = useRewindContext();
  const pendingText = useRewindComposerStore((state) => state.pendingText);
  const consume = useRewindComposerStore((state) => state.consume);

  useEffect(() => {
    if (!context || pendingText === null) {
      return;
    }
    // react-doctor-disable-next-line react-doctor/no-event-handler -- This effect drains a cross-package external store into assistant-ui's composer; the producing event happens in another package's modal, with no DOM event here.
    aui.composer().setText(pendingText);
    consume();
  }, [aui, consume, context, pendingText]);

  return null;
}
