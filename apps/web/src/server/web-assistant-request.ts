import type {
  AgentMessage,
  AssistantRequestPayload,
  AssistantToolApprovalAction,
} from '@brainstrike/agent';
import {
  AssistantAttachmentValidationError,
  AssistantInvalidJsonError,
  AssistantMessageValidationError,
  AssistantRequestBodyTooLargeError,
  convertAssistantUiMessages,
  parseAssistantRequestPayloadText,
  readToolApprovalRunConfigAction,
} from '@brainstrike/agent';

export interface WebAssistantInputError {
  payload:
    | { error: string }
    | { error: string; message: string }
    | { error: string; message: string; reason: string };
  status: 400 | 413;
}

export interface WebAssistantNormalTurn {
  agentMessages: AgentMessage[];
  payload: AssistantRequestPayload;
}

export interface WebAssistantTurn extends WebAssistantNormalTurn {
  toolApprovalAction?: AssistantToolApprovalAction;
}

export class EmptyAssistantPromptError extends Error {
  constructor() {
    super('Assistant request must end with a non-empty user prompt.');
    this.name = 'EmptyAssistantPromptError';
  }
}

export class InvalidToolApprovalActionError extends Error {
  constructor() {
    super('Tool approval action must include action, runId, and toolCallId.');
    this.name = 'InvalidToolApprovalActionError';
  }
}

function resolveNormalTurn(payload: AssistantRequestPayload): WebAssistantNormalTurn {
  const agentMessages = convertAssistantUiMessages(payload.rawMessages);
  const lastMessage = agentMessages.at(-1);
  const hasNonEmptyText = lastMessage?.parts.some(
    (part) => part.type === 'text' && part.text.trim().length > 0
  );
  if (lastMessage?.role !== 'user' || !hasNonEmptyText) {
    throw new EmptyAssistantPromptError();
  }
  return { agentMessages, payload };
}

export function resolveWebAssistantChatTurn(bodyText: string): WebAssistantNormalTurn {
  return resolveNormalTurn(parseAssistantRequestPayloadText(bodyText));
}

export function resolveWebAssistantTurn(bodyText: string): WebAssistantTurn {
  const payload = parseAssistantRequestPayloadText(bodyText);
  const approvalResult = readToolApprovalRunConfigAction(payload.runConfig);
  if (approvalResult && 'invalid' in approvalResult) {
    throw new InvalidToolApprovalActionError();
  }
  const toolApprovalAction = approvalResult?.action;
  if (toolApprovalAction) {
    return { agentMessages: [], payload, toolApprovalAction };
  }
  return resolveNormalTurn(payload);
}

export function describeWebAssistantInputError(error: unknown): WebAssistantInputError | null {
  if (error instanceof AssistantRequestBodyTooLargeError) {
    return {
      payload: { error: error.code, message: error.message },
      status: 413,
    };
  }
  if (
    error instanceof AssistantInvalidJsonError ||
    error instanceof AssistantMessageValidationError
  ) {
    return {
      payload: { error: error.code, message: error.message },
      status: 400,
    };
  }
  if (error instanceof AssistantAttachmentValidationError) {
    return {
      payload: {
        error: 'invalid_attachment',
        message: 'Assistant attachment payload is invalid.',
        reason: error.reason,
      },
      status: 400,
    };
  }
  if (error instanceof EmptyAssistantPromptError) {
    return { payload: { error: 'empty_prompt' }, status: 400 };
  }
  if (error instanceof InvalidToolApprovalActionError) {
    return {
      payload: {
        error: 'invalid_tool_approval_action',
        message: error.message,
      },
      status: 400,
    };
  }
  return null;
}
