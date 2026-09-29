import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { ApprovalCard } from './approval-card';
import { resolveApprovalPresentation } from './approval-presentation';
import { useApprovalRank } from './approval-ranks-context';
import { ApprovalRow } from './approval-row';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';
import { useApprovalNoticeState } from './use-approval-notice-state';

interface AssistantToolApprovalNoticeProps {
  /** Durable owner color; omitted approvals inherit the current panel color. */
  colorId?: string | undefined;
  data: unknown;
  ownerDisplayName?: string | undefined;
  presentation?: 'timeline' | 'review' | undefined;
}

/**
 * The approval data part's renderer (`TOOL_APPROVAL_DATA_NAME`,
 * `assistant-data-renderer-registration.tsx`). Keyed by the approval's
 * identity so a re-used part slot never inherits another pause's state.
 * Live and rediscovered approvals share this component.
 */
export function AssistantToolApprovalNotice({
  data,
  colorId,
  ownerDisplayName,
  presentation = 'timeline',
}: AssistantToolApprovalNoticeProps) {
  if (!isAssistantToolApprovalRequest(data)) {
    return null;
  }
  return (
    <ToolApprovalNotice
      approval={data}
      colorId={colorId}
      key={getToolActionIdentityKey(data)}
      ownerDisplayName={ownerDisplayName}
      presentation={presentation}
    />
  );
}

function ToolApprovalNotice({
  approval,
  colorId,
  ownerDisplayName,
  presentation: surface,
}: {
  approval: AssistantToolApprovalRequest;
  colorId?: string | undefined;
  ownerDisplayName?: string | undefined;
  presentation: 'timeline' | 'review';
}) {
  const state = useApprovalNoticeState(approval);
  const pendingRank = useApprovalRank(getToolActionIdentityKey(approval));
  const presentation = resolveApprovalPresentation({ answered: state.answered, pendingRank });
  if (surface === 'timeline' && presentation.mode === 'row') {
    return (
      <ApprovalRow
        approval={approval}
        colorId={colorId}
        ownerDisplayName={ownerDisplayName}
        state={state}
      />
    );
  }
  return (
    <ApprovalCard
      approval={approval}
      colorId={colorId}
      ownerDisplayName={ownerDisplayName}
      presentation={surface === 'review' ? 'review' : 'card'}
      state={state}
    />
  );
}

AssistantToolApprovalNotice.displayName = 'AssistantToolApprovalNotice';
