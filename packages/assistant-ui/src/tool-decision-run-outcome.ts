import {
  isDelegatedToolActionIdentity,
  isMatchingToolAction,
} from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalDecision,
  type AssistantToolApprovalRequest,
  isAssistantToolApprovalAnswered,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  type AssistantToolSuspendRequest,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAssistantToolApprovalRequest(
  value: unknown
): value is AssistantToolApprovalRequest {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['toolCallId'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    (!('delegation' in value) ||
      (Object.hasOwn(value, 'delegation') && isDelegatedToolActionIdentity(value['delegation'])))
  );
}

export type ApprovalRunOutcomeState = 'none' | 'pending' | 'retryable' | 'completed';

export interface ApprovalRunOutcome {
  action: AssistantToolApprovalDecision | null;
  /**
   * Index of the user decision message this outcome was resolved from, or -1
   * while the pause has no answer. Successive runs repeat the same
   * `action`/`state` pair — a failed run, another answer, a second failed run
   * is `retryable` twice — so this is what tells one attempt from the next.
   * The send-failure and optimistic-lock stamps in
   * `use-approval-notice-state.ts` rely on it.
   */
  decisionIndex: number;
  state: ApprovalRunOutcomeState;
}

const emptyApprovalRunOutcome: ApprovalRunOutcome = {
  action: null,
  decisionIndex: -1,
  state: 'none',
};
function isMatchingApprovalAction(value: unknown, approval: AssistantToolApprovalRequest): boolean {
  return isMatchingToolAction(value, approval);
}

function getMessageRole(message: unknown): unknown {
  return isRecord(message) ? message['role'] : undefined;
}

function getMessageStatus(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) {
    return;
  }
  const status = message['status'];
  return isRecord(status) ? status : undefined;
}

function getToolApprovalActionFromMessage(message: unknown): unknown {
  if (!isRecord(message)) {
    return;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return;
  }
  const custom = metadata['custom'];
  if (!isRecord(custom)) {
    return;
  }
  return custom[TOOL_APPROVAL_RUN_CONFIG_KEY];
}

function getToolApprovalDecision(value: unknown): AssistantToolApprovalDecision | null {
  if (!isRecord(value)) {
    return null;
  }
  const action = value['action'];
  return action === 'approve' || action === 'decline' ? action : null;
}

function getLiveApprovalDecisionFromMessage(
  message: unknown,
  approval: AssistantToolApprovalRequest
): AssistantToolApprovalDecision | null {
  if (
    !(isRecord(message) && message['role'] === 'assistant' && Array.isArray(message['content']))
  ) {
    return null;
  }
  for (const part of message['content']) {
    if (
      isRecord(part) &&
      part['type'] === 'data' &&
      part['name'] === TOOL_APPROVAL_ANSWERED_DATA_NAME &&
      isAssistantToolApprovalAnswered(part['data']) &&
      part['data'].reason === 'user' &&
      isMatchingApprovalAction(part['data'], approval)
    ) {
      return part['data'].decision;
    }
  }
  return null;
}

export function resolveApprovalRunOutcome(
  messages: readonly unknown[],
  approval: AssistantToolApprovalRequest | null
): ApprovalRunOutcome {
  if (!approval) {
    return emptyApprovalRunOutcome;
  }

  let submittedMessageIndex = -1;
  let submittedAction: AssistantToolApprovalDecision | null = null;
  let submittedLive = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const approvalAction = getToolApprovalActionFromMessage(message);
    if (getMessageRole(message) === 'user' && isMatchingApprovalAction(approvalAction, approval)) {
      submittedMessageIndex = index;
      submittedAction = getToolApprovalDecision(approvalAction);
      break;
    }
    const liveDecision = getLiveApprovalDecisionFromMessage(message, approval);
    if (liveDecision !== null) {
      submittedMessageIndex = index;
      submittedAction = liveDecision;
      submittedLive = true;
      break;
    }
  }
  if (submittedMessageIndex < 0) {
    return emptyApprovalRunOutcome;
  }

  const decisionIndex = submittedMessageIndex;
  for (
    let index = submittedMessageIndex + (submittedLive ? 0 : 1);
    index < messages.length;
    index += 1
  ) {
    const message = messages[index];
    const role = getMessageRole(message);
    if (role === 'user') {
      return { action: submittedAction, decisionIndex, state: 'pending' };
    }
    if (role !== 'assistant') {
      continue;
    }

    const status = getMessageStatus(message);
    if (status?.['type'] === 'complete') {
      return { action: submittedAction, decisionIndex, state: 'completed' };
    }
    if (status?.['type'] === 'incomplete') {
      return { action: submittedAction, decisionIndex, state: 'retryable' };
    }
    return { action: submittedAction, decisionIndex, state: 'pending' };
  }

  return { action: submittedAction, decisionIndex, state: 'pending' };
}

export function isAssistantToolSuspendRequest(
  value: unknown
): value is AssistantToolSuspendRequest {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['toolCallId'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    (!('delegation' in value) ||
      (Object.hasOwn(value, 'delegation') && isDelegatedToolActionIdentity(value['delegation'])))
  );
}

function isMatchingResumeAction(value: unknown, request: AssistantToolSuspendRequest): boolean {
  return isMatchingToolAction(value, request);
}

function getResumeActionFromMessage(message: unknown): unknown {
  if (!isRecord(message)) {
    return;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return;
  }
  const custom = metadata['custom'];
  return isRecord(custom) ? custom[TOOL_SUSPEND_RUN_CONFIG_KEY] : undefined;
}

function getMessageStatusType(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return;
  }
  const status = message['status'];
  return isRecord(status) && typeof status['type'] === 'string' ? status['type'] : undefined;
}

/**
 * Lifecycle of the run kicked off by a resume for THIS suspended call:
 *   - `none`       — no matching resume appended yet.
 *   - `pending`    — a resume is in flight (still streaming, or awaiting a new run).
 *   - `retryable`  — the resumed run FAILED (assistant status `incomplete`); the
 *                    controls RE-ENABLE so the user can resubmit (mirrors the
 *                    approval notice — a stale/failed resume must not lock forever).
 *   - `completed`  — the resumed run finished successfully; controls stay locked.
 */
type SuspendRunOutcomeState = 'none' | 'pending' | 'retryable' | 'completed';

/**
 * Scan the thread for a `user` message carrying a matching `brainstrikeToolSuspend`
 * action, then classify the run that followed it. Mirrors the approval notice's
 * `resolveApprovalRunOutcome`: a failed resume is `retryable` (controls unlock),
 * never permanently locked.
 */
export function resolveSuspendRunOutcome(
  messages: readonly unknown[],
  request: AssistantToolSuspendRequest | null
): SuspendRunOutcomeState {
  if (!request) {
    return 'none';
  }
  let submittedIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      getMessageRole(message) === 'user' &&
      isMatchingResumeAction(getResumeActionFromMessage(message), request)
    ) {
      submittedIndex = index;
      break;
    }
  }
  if (submittedIndex < 0) {
    return 'none';
  }

  for (let index = submittedIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    const role = getMessageRole(message);
    if (role === 'user') {
      return 'pending';
    }
    if (role !== 'assistant') {
      continue;
    }
    const statusType = getMessageStatusType(message);
    if (statusType === 'complete') {
      return 'completed';
    }
    if (statusType === 'incomplete') {
      return 'retryable';
    }
    return 'pending';
  }
  return 'pending';
}
