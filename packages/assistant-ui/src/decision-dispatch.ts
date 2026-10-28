import type { CreateAppendMessage } from '@assistant-ui/react';

export type DecisionDispatchOutcome = 'queued' | 'sent';

/**
 * Send a tool decision (approval / typed resume) through the root thread.
 *
 * Appending a message used to CANCEL the in-flight run in the installed
 * assistant-ui runtime. Two decisions answered back to back — the root's own
 * canvas write, then a child's "Allow reads this session" — aborted the first
 * resume leg three seconds in and lost the second click entirely
 * (thread-b3cea1f6, 2026-09-14, desktop log `mastra_agent_stream_aborted`).
 * A decision is never a reason to cancel work.
 *
 * While the thread runs, its runtime holds assistant-ui's message queue
 * (`thread-message-queue.ts`), so the same append waits in line instead: it
 * goes next, ahead of typed follow-ups, and is sent when the run ends. The
 * queue has no cancel driver, so it never interrupts the run.
 */
export async function submitDecisionOrQueue(params: {
  readonly append: (message: CreateAppendMessage) => unknown;
  readonly isRunning: boolean;
  readonly message: CreateAppendMessage;
}): Promise<DecisionDispatchOutcome> {
  params.append(params.message);
  return params.isRunning ? 'queued' : 'sent';
}
