import { type DataMessagePartComponent, useAuiState } from '@assistant-ui/react';
import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { shouldShowBackgroundActivity } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';
import { useAssistantRunEventDerivation } from './assistant-run-event-context';
import {
  AssistantRunTimeline,
  isAlwaysVisibleRunEvent,
  resolveAssistantRunEventRenderPlan,
  resolveAssistantRunEventStatus,
} from './assistant-run-timeline';

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
  if (shouldShowBackgroundActivity(detailLevel)) {
    return <VisibleAssistantRunTimelineDataPart data={data} />;
  }
  return isAlwaysVisibleRunEvent(data) ? (
    <AlwaysVisibleAssistantRunTimelineDataPart data={data} />
  ) : null;
};
