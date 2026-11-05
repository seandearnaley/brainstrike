import type { HostClient } from '@brainstrike/agent-host/browser';
import type { ReadApprovalChange } from '@brainstrike/assistant-ui';
import type { CommittedHostConversation } from './committed-host-conversation';

type Conversation = Pick<CommittedHostConversation, 'approvals' | 'store'>;

/** The run and thread an interaction waits in: the viewed thread, or one delegated beneath it. */
function waitingIn(
  conversation: Conversation,
  interactionId: string
): { readonly runId: string; readonly threadId: string } | undefined {
  const own = conversation.store
    .getCommittedView()
    .pendingInteractions.find((interaction) => interaction.interactionId === interactionId);
  if (own) {
    return own;
  }
  const delegated = conversation.approvals
    .getSnapshot()
    .find(({ approval }) => approval.interactionId === interactionId);
  return delegated && { runId: delegated.approval.runId, threadId: delegated.threadId };
}

/**
 * ADR-0036: an approval card's read of the file its waiting call would
 * change, which the host reads in the thread and run the call waits in.
 */
export function hostApprovalChange(
  client: Pick<HostClient, 'request'>,
  conversation: Conversation
): ReadApprovalChange {
  return async (interactionId) => {
    const waiting = waitingIn(conversation, interactionId);
    if (!waiting) {
      throw new Error('This approval is no longer waiting.');
    }
    return await client.request('interaction/preview', {
      interactionId,
      runId: waiting.runId,
      threadId: waiting.threadId,
    });
  };
}
