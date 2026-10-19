import {
  AssistantAttachmentValidationError,
  AssistantInvalidJsonError,
  AssistantMessageValidationError,
  AssistantRequestBodyTooLargeError,
  AssistantRequestEnvelopeValidationError,
} from '@brainstrike/agent/hosted-web';

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

export const WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE = {
  error: 'stream_resume_unavailable',
  message:
    'Hosted Web stream replay requires durable storage and is unavailable for this deployment.',
} as const;

export function describeWebAssistantInputError(error: unknown): WebAssistantInputError | null {
  if (error instanceof AssistantRequestBodyTooLargeError) {
    return {
      payload: { error: error.code, message: error.message },
      status: 413,
    };
  }
  if (
    error instanceof AssistantInvalidJsonError ||
    error instanceof AssistantMessageValidationError ||
    error instanceof AssistantRequestEnvelopeValidationError
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
  return null;
}
