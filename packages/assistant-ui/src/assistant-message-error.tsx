import { ActionBarPrimitive, ErrorPrimitive, useAuiState } from '@assistant-ui/react';
import { Button, CopyTextButton } from '@brainstrike/ui';
import { AlertCircle, RefreshCwIcon } from 'lucide-react';
import { useRef } from 'react';
import { selectHasErrorState } from './message-error-state.ts';

/**
 * Visible error block for a failed assistant run: a "Response failed" title,
 * the raw error text in a monospace detail with Copy, and Retry where the
 * runtime can reload the message.
 *
 * Transport/initialization failures (e.g. the assistant server rejecting a
 * request before any stream part is produced) reject the run with NO message
 * parts; without this block the thread shows an empty assistant bubble and
 * the failure is invisible. The block renders nothing when the message has no
 * error, so this is safe to mount on every assistant message.
 */
export const AssistantMessageError = () => {
  const hasError = useAuiState(selectHasErrorState);
  const canReload = useAuiState((state) => state.thread.capabilities.reload);
  const messageRef = useRef<HTMLSpanElement>(null);
  return (
    // Root is an UNSTYLED always-rendered live region; all visible chrome
    // renders only when the message actually has an error — styling Root
    // paints an empty red bar under every assistant message.
    <ErrorPrimitive.Root>
      {hasError ? (
        <div
          className="border-destructive/40 bg-destructive/5 mt-1 rounded-md border px-3 py-2 text-sm"
          data-testid="assistant-message-error"
        >
          <div className="flex items-center gap-2">
            <AlertCircle aria-hidden="true" className="text-destructive size-4 shrink-0" />
            <p className="text-destructive min-w-0 flex-1 font-medium">Response failed</p>
            {canReload ? (
              <ActionBarPrimitive.Reload asChild>
                <Button className="h-7 gap-1.5 px-2 text-xs" size="sm" variant="outline">
                  <RefreshCwIcon aria-hidden="true" className="size-3.5" />
                  Retry
                </Button>
              </ActionBarPrimitive.Reload>
            ) : null}
          </div>
          <div className="mt-1.5 flex items-start gap-1">
            {/* The library's own text for the error, so this reads exactly what
                the runtime recorded. */}
            <ErrorPrimitive.Message
              className="text-foreground/90 bg-muted/40 block max-h-48 min-w-0 flex-1 overflow-auto rounded p-1.5 font-mono text-xs break-words whitespace-pre-wrap"
              ref={messageRef}
            />
            <CopyTextButton
              ariaLabel="Copy error message"
              className="h-6 shrink-0 px-1.5"
              text={() => messageRef.current?.textContent ?? ''}
            />
          </div>
        </div>
      ) : null}
    </ErrorPrimitive.Root>
  );
};
