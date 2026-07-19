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

export const WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE = {
  payload: {
    error: 'agent_stream_init_failed',
    message: 'Assistant stream initialization failed',
  },
  status: 502,
} as const;

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
    super(
      'Tool approval action must contain only action, runId, toolCallId, and optional toolName with bounded non-empty identifiers.'
    );
    this.name = 'InvalidToolApprovalActionError';
  }
}

function isUserMessage(value: unknown): boolean {
  if (!(value && typeof value === 'object' && 'role' in value)) {
    return false;
  }
  return typeof value.role === 'string' && value.role.toLowerCase() === 'user';
}

function resolveNormalTurn(payload: AssistantRequestPayload): WebAssistantNormalTurn {
  const lastRawMessage = payload.rawMessages.at(-1) as unknown;
  if (!isUserMessage(lastRawMessage)) {
    throw new EmptyAssistantPromptError();
  }

  const finalAgentMessage = convertAssistantUiMessages(payload.rawMessages.slice(-1)).at(-1);
  const hasNonEmptyText = finalAgentMessage?.parts.some(
    (part) => part.type === 'text' && part.text.trim().length > 0
  );
  if (finalAgentMessage?.role !== 'user' || !hasNonEmptyText) {
    throw new EmptyAssistantPromptError();
  }

  const agentMessages = convertAssistantUiMessages(payload.rawMessages);
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
