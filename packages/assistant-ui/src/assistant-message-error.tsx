import { ErrorPrimitive } from '@assistant-ui/react';

/**
 * Visible error block for a failed assistant run.
 *
 * Transport/initialization failures (e.g. the assistant server rejecting a
 * request before any stream part is produced) reject the run with NO message
 * parts; without this block the thread shows an empty assistant bubble and
 * the failure is invisible. `ErrorPrimitive.Message` renders nothing when the
 * message has no error, so this is safe to mount on every assistant message.
 */
export const AssistantMessageError = () => (
  // Root is an UNSTYLED always-rendered live region; all visible chrome lives
  // on Message, which renders only when the message actually has an error —
  // styling Root paints an empty red bar under every assistant message.
  <ErrorPrimitive.Root>
    <ErrorPrimitive.Message className="border-destructive/40 bg-destructive/5 text-destructive mt-1 block rounded-md border px-3 py-2 text-sm break-words" />
  </ErrorPrimitive.Root>
);
