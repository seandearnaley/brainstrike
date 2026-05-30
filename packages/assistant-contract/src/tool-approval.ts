export const TOOL_APPROVAL_DATA_NAME = 'brainstrike.tool-approval';

export interface AssistantToolApprovalRequest {
  args?: unknown;
  resumeSchema?: unknown;
  runId: string;
  toolCallId: string;
  toolName: string;
}
