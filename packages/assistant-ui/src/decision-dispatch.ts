import type { CreateAppendMessage } from '@assistant-ui/react';
import { followUpQueueKey, useFollowUpQueueStore } from './follow-up-queue-store';

export type DecisionDispatchOutcome = 'queued' | 'sent';

/**
 * Send a tool decision (approval / typed resume) through the root thread.
 *
 * The installed assistant-ui runtime CANCELS the in-flight run when a new
 * message is appended. Two decisions answered back to back — the root's own
 * canvas write, then a child's "Allow reads this session" — therefore aborted
 * the first resume leg three seconds in and lost the second click entirely
 * (thread-b3cea1f6, 2026-09-14, desktop log `mastra_agent_stream_aborted`).
 * A decision is never a reason to cancel work.
 *
 * While the thread runs, the decision waits its turn in the follow-up queue
 * exactly as a typed follow-up does (`FollowUpQueueBridge` dispatches one per
 * run end), and the host serializes the resulting legs.
 */
export async function submitDecisionOrQueue(params: {
  readonly append: (message: CreateAppendMessage) => unknown;
  readonly identityKey: string;
  readonly isRunning: boolean;
  readonly message: CreateAppendMessage;
  readonly text: string;
  readonly threadKey: string | undefined;
}): Promise<DecisionDispatchOutcome> {
  if (!params.isRunning) {
    params.append(params.message);
    return 'sent';
  }
  useFollowUpQueueStore.getState().enqueueMessage(followUpQueueKey(params.threadKey), {
    identityKey: params.identityKey,
    message: params.message,
    text: params.text,
  });
  return 'queued';
}
