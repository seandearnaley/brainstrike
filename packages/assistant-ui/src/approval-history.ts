import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import type { IndexedApprovalRequest } from './answered-approvals-index-model';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';

/** Only a real, addressable approval card can replace its duplicate pause chrome. */
export function approvalCardToolCallIds(
  parts: readonly unknown[],
  requests?: ReadonlyMap<string, IndexedApprovalRequest>
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    // Rediscovery can put the card in a separate message. Match the recorded
    // pause's run AND surface call, never a child leaf id or an unscoped id.
    const event = readAssistantRunEventDataPart(part);
    if (event?.kind === 'tool.approval.requested' && event.runId && requests) {
      const callId = event.metadata?.['toolCallId'];
      for (const { request } of requests.values()) {
        if (request.runId === event.runId && request.toolCallId === callId) {
          ids.add(request.toolCallId);
          break;
        }
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
