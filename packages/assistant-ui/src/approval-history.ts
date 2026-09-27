import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';

/** Only a real, addressable approval card can replace its duplicate pause chrome. */
export function approvalCardToolCallIds(parts: readonly unknown[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const part of parts) {
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
