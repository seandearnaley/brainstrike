import type { CreateAppendMessage } from '@assistant-ui/react';
import { getToolActionIdentityKey, getToolActionTarget } from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalAction,
  type AssistantToolApprovalDecision,
  type AssistantToolApprovalRequest,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';

export interface ApprovalDecisionMessage {
  /** `getToolActionIdentityKey` of the approval — the queue/index key. */
  readonly identityKey: string;
  readonly message: CreateAppendMessage;
  /** The echo text ("Approved <tool>."), also the follow-up queue chip label. */
  readonly text: string;
}

/**
 * The bookkeeping message an approval decision appends (APPROVAL ACTION
 * MESSAGES ARE BOOKKEEPING, assistant-runtime.md): the action rides in
 * `metadata.custom` (thread-state locking) AND `runConfig.custom` (the resume
 * route). Shared by the card's buttons and the composer strip so both send
 * byte-identical decisions.
 */
export function buildApprovalDecisionMessage(
  approval: AssistantToolApprovalRequest,
  action: AssistantToolApprovalDecision
): ApprovalDecisionMessage {
  const approvalAction: AssistantToolApprovalAction = {
    action,
    ...getToolActionTarget(approval),
    toolName: approval.toolName,
  };
  const text = `${action === 'approve' ? 'Approved' : 'Declined'} ${approval.toolName}.`;
  const message = {
    content: [{ text, type: 'text' }],
    metadata: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction } },
    role: 'user',
    runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction } },
    startRun: true,
  } satisfies CreateAppendMessage;
  return { identityKey: getToolActionIdentityKey(approval), message, text };
}
