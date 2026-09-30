import {
  getToolActionIdentityKey,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalAnswered,
  type AssistantToolApprovalRequest,
  isAssistantToolApprovalAnswered,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  approvalSurfaceCallKey,
  type IndexedApprovalRequest,
} from './answered-approvals-index-model';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';

/** A leaf key alone does not establish the surface or the complete ancestry. */
function isExactSurfaceAnswer(
  answer: AssistantToolApprovalAnswered,
  request: AssistantToolApprovalRequest
): boolean {
  if (
    answer.runId !== request.runId ||
    answer.toolCallId !== request.toolCallId ||
    answer.toolName !== request.toolName ||
    answer.continuationId !== request.continuationId
  ) {
    return false;
  }
  const answered = answer.delegation;
  const requested = request.delegation;
  if (!(answered && requested)) {
    return answered === requested;
  }
  return (
    answered.toolCallId === requested.toolCallId &&
    answered.path.length === requested.path.length &&
    answered.path.every((edge, index) => {
      const original = requested.path[index];
      return (
        original?.childRuntimeRunId === edge.childRuntimeRunId &&
        original.parentRuntimeRunId === edge.parentRuntimeRunId &&
        original.parentToolCallId === edge.parentToolCallId &&
        original.personaId === edge.personaId
      );
    })
  );
}

/** Associate only this message's host answer with its original addressable card. */
function answeredApprovalSurfaceCall(
  part: unknown,
  cardedSurfaceCalls: ReadonlySet<string> | undefined,
  requests: ReadonlyMap<string, IndexedApprovalRequest> | undefined
): string | undefined {
  if (
    !(
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'data' &&
      'name' in part &&
      part.name === TOOL_APPROVAL_ANSWERED_DATA_NAME &&
      'data' in part &&
      isAssistantToolApprovalAnswered(part.data)
    )
  ) {
    return;
  }
  // A reconstructed leg seeds the approved call under its NEW host leg.
  // Global answers and bare reused call ids cannot identify that copy.
  const request = requests?.get(getToolActionIdentityKey(part.data))?.request;
  if (
    !(
      request?.timelineRunId &&
      cardedSurfaceCalls?.has(approvalSurfaceCallKey(request.timelineRunId, request.toolCallId)) &&
      isExactSurfaceAnswer(part.data, request)
    )
  ) {
    return;
  }
  return request.toolCallId;
}

function toolPartCallId(part: unknown): string | undefined {
  if (
    typeof part !== 'object' ||
    part === null ||
    !('type' in part) ||
    part.type !== 'tool-call' ||
    !('toolCallId' in part) ||
    typeof part.toolCallId !== 'string'
  ) {
    return;
  }
  return part.toolCallId;
}

function retainUnambiguousCallIds(
  ids: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>
): ReadonlySet<string> {
  return new Set([...ids].filter((id) => (counts.get(id) ?? 0) < 2));
}

/** Only a real, addressable approval card can replace its duplicate pause chrome. */
export function approvalCardToolCallIds(
  parts: readonly unknown[],
  cardedSurfaceCalls?: ReadonlySet<string>,
  requests?: ReadonlyMap<string, IndexedApprovalRequest>
): ReadonlySet<string> {
  const ids = new Set<string>();
  const toolCallCounts = new Map<string, number>();
  for (const part of parts) {
    const partCallId = toolPartCallId(part);
    if (partCallId !== undefined) {
      toolCallCounts.set(partCallId, (toolCallCounts.get(partCallId) ?? 0) + 1);
    }
    // A separate card matches the invocation's recorded HOST leg and surface
    // call, even when the pause event lives elsewhere. Never infer a native
    // Mastra run ID or a child leaf.
    const event = cardedSurfaceCalls?.size ? readAssistantRunEventDataPart(part) : undefined;
    if (
      (event?.kind === 'tool.approval.requested' || event?.kind === 'tool.started') &&
      event.runId
    ) {
      const callId = event.metadata?.['toolCallId'];
      if (
        typeof callId === 'string' &&
        cardedSurfaceCalls?.has(approvalSurfaceCallKey(event.runId, callId))
      ) {
        ids.add(callId);
      }
    }
    const answeredCall = answeredApprovalSurfaceCall(part, cardedSurfaceCalls, requests);
    if (answeredCall) {
      ids.add(answeredCall);
    }
    if (
      typeof part !== 'object' ||
      part === null ||
      !('type' in part) ||
      part.type !== 'data' ||
      !('name' in part) ||
      part.name !== TOOL_APPROVAL_DATA_NAME ||
      !('data' in part) ||
      !isAssistantToolApprovalRequest(part.data)
    ) {
      continue;
    }
    ids.add(part.data.toolCallId);
  }
  // Tool parts do not carry native/ancestry coordinates. Two same-id parts
  // cannot be individually addressed by this projection; retain both rather
  // than applying one proven answer to an unrelated invocation.
  return retainUnambiguousCallIds(ids, toolCallCounts);
}
