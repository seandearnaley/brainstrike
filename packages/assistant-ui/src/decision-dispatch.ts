import type { CreateAppendMessage } from '@assistant-ui/react';
import { followUpQueueKey, useFollowUpQueueStore } from './follow-up-queue-store';
import type { LiveDecisionTransport } from './live-decision-transport';

export type DecisionDispatchOutcome = 'delivered' | 'queued' | 'sent';

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
 * While the thread runs, the decision is delivered INTO the running turn
 * when the host offers a live transport (Claude Code answers a subagent's
 * prompt inside the live session; `POST /assistant/decide`). When no leg is
 * live for it — the turn settled between the click and the request, or the
 * host has no transport (web) — it waits its turn in the follow-up queue
 * exactly as a typed follow-up does (`FollowUpQueueBridge` dispatches one per
 * run end), and the host serializes the resulting legs. A transport failure
 * other than "not live" rejects: the caller unlocks the card and reports it.
 */
export async function submitDecisionOrQueue(params: {
  readonly append: (message: CreateAppendMessage) => unknown;
  readonly deliverLive?: LiveDecisionTransport | null | undefined;
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
  if (params.deliverLive && (await params.deliverLive(params.message)) === 'delivered') {
    return 'delivered';
  }
  useFollowUpQueueStore.getState().enqueueMessage(followUpQueueKey(params.threadKey), {
    identityKey: params.identityKey,
    message: params.message,
    text: params.text,
  });
  return 'queued';
}
