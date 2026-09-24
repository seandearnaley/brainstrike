import {
  type AssistantDataUIProps,
  type DataMessagePartComponent,
  useAssistantDataUI,
} from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  CHILD_RUN_USAGE_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  getToolActionIdentityKey,
  SHELL_OUTPUT_DATA_NAME,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
  TOOL_SUSPEND_DATA_NAME,
} from '@brainstrike/assistant-contract';
import { use, useEffect, useState } from 'react';
import { assistantDiscoveryErrorDataUI } from './assistant-discovery-error-data-ui';
import { AssistantRunTimelineDataPart } from './assistant-run-timeline-data-part';
import { AssistantToolApprovalNotice } from './assistant-tool-approval-notice';
import { AssistantToolSuspendNotice } from './assistant-tool-suspend-notice';
import {
  type DelegatedApprovalOwner,
  DelegatedApprovalOwnerContext,
} from './subagent-conversation-navigation';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';

const AssistantToolApprovalDataPart: DataMessagePartComponent = ({ data }) => {
  const resolveOwner = use(DelegatedApprovalOwnerContext);
  const [resolved, setResolved] = useState<{
    key: string;
    owner: DelegatedApprovalOwner | undefined;
  } | null>(null);
  const approval = isAssistantToolApprovalRequest(data) ? data : null;
  const key = approval ? getToolActionIdentityKey(approval) : null;
  useEffect(() => {
    if (!(approval?.delegation && resolveOwner && key)) {
      return;
    }
    let active = true;
    resolveOwner(approval).then(
      (owner) => {
        if (active) {
          setResolved({ key, owner });
        }
      },
      () => {
        if (active) {
          setResolved({ key, owner: undefined });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [approval, key, resolveOwner]);
  const owner = resolved?.key === key ? resolved.owner : undefined;
  const colorId = approval?.delegation ? (owner?.colorId ?? 'unresolved') : undefined;
  const ownerUnavailable =
    approval?.delegation && (!resolveOwner || (resolved?.key === key && !resolved.owner));
  return (
    <>
      {ownerUnavailable ? (
        <div className="text-muted-foreground text-xs" role="status">
          Approval owner unavailable: child identity could not be verified.
        </div>
      ) : null}
      <AssistantToolApprovalNotice
        colorId={colorId}
        data={data}
        ownerDisplayName={owner?.displayName}
      />
    </>
  );
};

const assistantRunTimelineDataUI = {
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
  render: AssistantRunTimelineDataPart,
} satisfies AssistantDataUIProps;

const assistantToolApprovalDataUI = {
  name: TOOL_APPROVAL_DATA_NAME,
  render: AssistantToolApprovalDataPart,
} satisfies AssistantDataUIProps;

// A host-answered approval (session grant answering a parked sibling) is
// consumed by the notice it answers — `AssistantToolApprovalNotice` scans the
// thread for it and locks — NOT rendered as its own row.
const assistantToolApprovalAnsweredDataUI = {
  name: TOOL_APPROVAL_ANSWERED_DATA_NAME,
  render: () => null,
} satisfies AssistantDataUIProps;

const AssistantToolSuspendDataPart: DataMessagePartComponent = ({ data }) => (
  <AssistantToolSuspendNotice data={data} />
);

const assistantToolSuspendDataUI = {
  name: TOOL_SUSPEND_DATA_NAME,
  render: AssistantToolSuspendDataPart,
} satisfies AssistantDataUIProps;

// Live shell-output slices are consumed by the tool card (via the incremental
// shell-output accumulator + ShellOutputProvider), NOT rendered inline in the
// message flow — register a null renderer so the transient data parts never
// surface as stray elements.
const assistantShellOutputDataUI = {
  name: SHELL_OUTPUT_DATA_NAME,
  render: () => null,
} satisfies AssistantDataUIProps;

// The run-start prompt breakdown is consumed by the onContextBreakdown tap
// (buildContextBreakdownTap in data-stream-runtime.ts) and rendered in the
// Context Usage popover, NOT inline in the message flow — register a null
// renderer so the transient data part never surfaces as a stray element
// (mirrors assistantShellOutputDataUI above).
const assistantContextBreakdownDataUI = {
  name: CONTEXT_BREAKDOWN_DATA_NAME,
  render: () => null,
} satisfies AssistantDataUIProps;

// Child model-call usage (subagent / OM cycle, BST-953) is consumed by the
// onChildRunUsage tap and rendered in the Context Usage popover's thread-total
// section, NOT inline in the message flow — same null-renderer contract as the
// breakdown part above.
const assistantChildRunUsageDataUI = {
  name: CHILD_RUN_USAGE_DATA_NAME,
  render: () => null,
} satisfies AssistantDataUIProps;

export const AssistantDataRendererRegistration = () => {
  useAssistantDataUI(assistantRunTimelineDataUI);
  useAssistantDataUI(assistantDiscoveryErrorDataUI);
  useAssistantDataUI(assistantToolApprovalDataUI);
  useAssistantDataUI(assistantToolApprovalAnsweredDataUI);
  useAssistantDataUI(assistantToolSuspendDataUI);
  useAssistantDataUI(assistantShellOutputDataUI);
  useAssistantDataUI(assistantContextBreakdownDataUI);
  useAssistantDataUI(assistantChildRunUsageDataUI);

  return null;
};
