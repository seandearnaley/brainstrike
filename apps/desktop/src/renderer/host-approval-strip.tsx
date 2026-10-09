import type { HostClient } from '@brainstrike/agent-host/browser';
import { CommittedApprovalStrip, type CommittedPendingApproval } from '@brainstrike/assistant-ui';
import { type ReactElement, useMemo, useSyncExternalStore } from 'react';
import { respondToHostApproval } from './host-approval-response';
import { HostChildWaiting } from './host-child-tree-notices';
import type { HostTreeApprovals } from './host-tree-approvals';

/**
 * BST-1932: a host thread's approvals strip. It counts the approvals waiting in
 * the thread and every thread delegated beneath it, and answers each in the
 * thread that asked; a delegated question or plan is named beside it (AT-08).
 */
export function HostApprovalStrip({
  client,
  self,
  tree,
}: {
  readonly client: Pick<HostClient, 'request'>;
  /** A child view's own call sign, which owns the approvals of the viewed thread itself. */
  readonly self: string | undefined;
  readonly tree: HostTreeApprovals;
}): ReactElement | null {
  const waiting = useSyncExternalStore(tree.subscribe, tree.getSnapshot, tree.getSnapshot);
  const approvals = useMemo(
    () =>
      waiting.map(({ approval, owner = self, threadId }): CommittedPendingApproval => {
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
    [client, self, waiting]
  );
  return (
    <>
      <CommittedApprovalStrip approvals={approvals} />
      <HostChildWaiting tree={tree} />
    </>
  );
}
