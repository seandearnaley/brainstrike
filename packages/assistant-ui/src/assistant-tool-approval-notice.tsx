import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { ApprovalCard } from './approval-card';
import { resolveApprovalPresentation } from './approval-presentation';
import { useApprovalRank } from './approval-presentation-context';
import { ApprovalRow } from './approval-row';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';
import { useApprovalNoticeState } from './use-approval-notice-state';

interface AssistantToolApprovalNoticeProps {
  data: unknown;
}

/**
 * The approval data part's renderer (`TOOL_APPROVAL_DATA_NAME`,
 * `assistant-data-renderer-registration.tsx`). Keyed by the approval's
 * identity so a re-used part slot never inherits another pause's state.
 * Live and rediscovered approvals share this component.
 */
export function AssistantToolApprovalNotice({ data }: AssistantToolApprovalNoticeProps) {
  if (!isAssistantToolApprovalRequest(data)) {
    return null;
  }
  return <ToolApprovalNotice approval={data} key={getToolActionIdentityKey(data)} />;
}

function ToolApprovalNotice({ approval }: { approval: AssistantToolApprovalRequest }) {
  const state = useApprovalNoticeState(approval);
  const pendingRank = useApprovalRank(getToolActionIdentityKey(approval));
  const presentation = resolveApprovalPresentation({ answered: state.answered, pendingRank });
  if (presentation.mode === 'row') {
    return <ApprovalRow approval={approval} state={state} />;
  }
  return <ApprovalCard approval={approval} presentation="card" state={state} />;
}

AssistantToolApprovalNotice.displayName = 'AssistantToolApprovalNotice';
