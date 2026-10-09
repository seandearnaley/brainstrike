import type { ReactElement } from 'react';
import { ApprovalRow } from './approval-row';
import type { SubagentAnsweredApproval } from './subagent-conversation-navigation';
import type { ApprovalNoticeState } from './use-approval-notice-state';

function status({ byPolicy, decision }: SubagentAnsweredApproval): string {
  if (decision === 'deny') {
    return 'Declined';
  }
  return byPolicy ? 'Allowed by session grant' : 'Approved';
}

function answeredState(approval: SubagentAnsweredApproval): ApprovalNoticeState {
  return {
    actionButtonsDisabled: true,
    answered: true,
    decisionLocked: true,
    delegationOwner: approval.owner,
    hostAnswer: null,
    rediscovered: null,
    sendError: null,
    status: status(approval),
    submitApprovalAction: () => {
      throw new Error('An answered approval cannot be decided again');
    },
  };
}

/**
 * BST-1932 (AT-07): a delegated child's answered approvals in its delegation
 * card, owner-named and locked, as the shipped root history notices were.
 */
export function SubagentApprovalHistory({
  approvals,
  colorId,
}: {
  readonly approvals: readonly SubagentAnsweredApproval[];
  readonly colorId: string | undefined;
}): ReactElement | null {
  if (approvals.length === 0) {
    return null;
  }
  return (
    <div className="border-border border-t px-2 py-1">
      {approvals.map((approval) => (
        <ApprovalRow
          approval={{
            args: approval.args,
            runId: approval.runId,
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
          }}
          colorId={colorId}
          key={approval.interactionId}
          ownerDisplayName={approval.owner}
          state={answeredState(approval)}
        />
      ))}
    </div>
  );
}
