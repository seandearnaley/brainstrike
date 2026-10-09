import type { HostClient } from '@brainstrike/agent-host/browser';
import { CommittedApprovalStrip, type CommittedPendingApproval } from '@brainstrike/assistant-ui';
import { type ReactElement, useMemo, useSyncExternalStore } from 'react';
import { respondToHostApproval } from './host-approval-response';
import type { HostTreeApprovals } from './host-tree-approvals';

/**
 * BST-1932: a host thread's approvals strip. It counts the approvals waiting in
 * the thread and every thread delegated beneath it, and answers each in the
 * thread that asked.
 */
export function HostApprovalStrip({
  client,
  tree,
}: {
  readonly client: Pick<HostClient, 'request'>;
  readonly tree: HostTreeApprovals;
}): ReactElement | null {
  const waiting = useSyncExternalStore(tree.subscribe, tree.getSnapshot, tree.getSnapshot);
  const approvals = useMemo(
    () =>
      waiting.map(({ approval, owner, threadId }): CommittedPendingApproval => {
        const toolName = approval.toolCatalogId ?? approval.toolId;
        return {
          args: approval.input,
          interactionId: approval.interactionId,
          ...(owner ? { owner } : {}),
          respond: (response) =>
            respondToHostApproval(
              client,
              {
                interactionId: approval.interactionId,
                permissionToolId: toolName,
                risk: approval.risk,
                runId: approval.runId,
                threadId,
              },
              response
            ),
          ...(approval.risk ? { risk: approval.risk } : {}),
          runId: approval.runId,
          toolCallId: approval.toolCallId,
          toolName,
        };
      }),
    [client, waiting]
  );
  return <CommittedApprovalStrip approvals={approvals} />;
}
