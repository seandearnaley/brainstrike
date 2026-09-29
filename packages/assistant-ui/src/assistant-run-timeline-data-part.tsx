import { type DataMessagePartComponent, useAuiState } from '@assistant-ui/react';
import { type AssistantRunEvent, readAssistantRunEvent } from '@brainstrike/assistant-contract';
import { useAnsweredApprovals } from './answered-approvals-context';
import { approvalSurfaceCallKey } from './answered-approvals-index-model';
import { approvalCardToolCallIds } from './approval-history';
import { shouldShowBackgroundActivity } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';
import { useAssistantRunEventDerivation } from './assistant-run-event-context';
import {
  isAlwaysVisibleRunEvent,
  resolveAssistantRunEventRenderPlan,
  resolveAssistantRunEventStatus,
} from './assistant-run-event-derivation';
import { AssistantRunTimeline } from './assistant-run-timeline';

function VisibleAssistantRunTimelineDataPart({ data }: { readonly data: unknown }) {
  const { renderPlanKey, status } = useAssistantRunEventDerivation(data);
  if (renderPlanKey === 'hidden') {
    return null;
  }
  return (
    <AssistantRunTimeline
      data={data}
      repeatCount={Number(renderPlanKey.slice('visible:'.length))}
      {...(status ? { statusOverride: status } : {})}
    />
  );
}

function AlwaysVisibleAssistantRunTimelineDataPart({ data }: { readonly data: unknown }) {
  const status = useAuiState((state) =>
    resolveAssistantRunEventStatus(state.thread.messages, data as AssistantRunEvent)
  );
  const planKey = useAuiState((state) => {
    const plan = resolveAssistantRunEventRenderPlan(state.thread.messages, data);
    return plan.hidden ? 'hidden' : `visible:${plan.repeatCount}`;
  });
  return planKey === 'hidden' ? null : (
    <AssistantRunTimeline
      data={data}
      repeatCount={Number(planKey.slice('visible:'.length))}
      statusOverride={status}
    />
  );
}

export const AssistantRunTimelineDataPart: DataMessagePartComponent = ({ data }) => {
  // Default detail keeps hidden rows out of the shared derivation context.
  // Terminal failures/cancellations retain their established per-row path.
  const { detailLevel } = useAssistantDetailLevel();
  const event = readAssistantRunEvent(data);
  const { cardedSurfaceCalls } = useAnsweredApprovals();
  const toolCallId = event?.metadata?.['toolCallId'];
  const hasApprovalCard = useAuiState(
    (state) =>
      event?.kind === 'tool.approval.requested' &&
      typeof toolCallId === 'string' &&
      ((event.runId !== undefined &&
        cardedSurfaceCalls.has(approvalSurfaceCallKey(event.runId, toolCallId))) ||
        approvalCardToolCallIds(state.message.parts).has(toolCallId))
  );
  if (hasApprovalCard) {
    return null;
  }
  if (shouldShowBackgroundActivity(detailLevel)) {
    return <VisibleAssistantRunTimelineDataPart data={data} />;
  }
  return isAlwaysVisibleRunEvent(data) ? (
    <AlwaysVisibleAssistantRunTimelineDataPart data={data} />
  ) : null;
};
