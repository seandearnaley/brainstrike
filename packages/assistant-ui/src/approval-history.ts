import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { approvalSurfaceCallKey } from './answered-approvals-index-model';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';

/** Only a real, addressable approval card can replace its duplicate pause chrome. */
export function approvalCardToolCallIds(
  parts: readonly unknown[],
  cardedSurfaceCalls?: ReadonlySet<string>
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const part of parts) {
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
  return ids;
}
