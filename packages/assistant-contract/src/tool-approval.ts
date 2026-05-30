export const TOOL_APPROVAL_DATA_NAME = 'brainstrike.tool-approval';
export const TOOL_APPROVAL_RUN_CONFIG_KEY = 'brainstrikeToolApproval';

export interface AssistantToolApprovalRequest {
  args?: unknown;
  resumeSchema?: unknown;
  runId: string;
  toolCallId: string;
  toolName: string;
}

export type AssistantToolApprovalDecision = 'approve' | 'decline';

export interface AssistantToolApprovalAction {
  action: AssistantToolApprovalDecision;
  runId: string;
  toolCallId: string;
  toolName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isAssistantToolApprovalAction(
  value: unknown
): value is AssistantToolApprovalAction {
  return (
    isRecord(value) &&
    (value['action'] === 'approve' || value['action'] === 'decline') &&
    typeof value['runId'] === 'string' &&
    value['runId'].trim().length > 0 &&
    typeof value['toolCallId'] === 'string' &&
    value['toolCallId'].trim().length > 0 &&
    (value['toolName'] === undefined || typeof value['toolName'] === 'string')
  );
}
