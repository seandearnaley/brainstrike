import type { AgentMessage, AssistantUiMessageStrict, RuntimeData } from './types';

export const ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR =
  'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES';
export const DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export interface AssistantRequestPayload {
  data: RuntimeData | undefined;
  rawMessages: AssistantUiMessageStrict[];
  runConfig: unknown;
}

export class AssistantInvalidJsonError extends Error {
  readonly code = 'invalid_json';

  constructor() {
    super('Request body must be valid JSON.');
    this.name = 'AssistantInvalidJsonError';
  }
}

export class AssistantRequestBodyTooLargeError extends Error {
  readonly code = 'request_body_too_large';

  constructor(readonly maxBodyBytes: number = DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES) {
    super(`Assistant request body exceeds ${maxBodyBytes} bytes.`);
    this.name = 'AssistantRequestBodyTooLargeError';
  }
}

export class AssistantRequestBodyLimitConfigError extends Error {
  constructor(value: string) {
    super(
      `${ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR} must be a positive integer byte count; received ${JSON.stringify(value)}.`
    );
    this.name = 'AssistantRequestBodyLimitConfigError';
  }
}

export function resolveAssistantRequestBodyLimitBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AssistantRequestBodyLimitConfigError(value);
  }
  return parsed;
}

export function parseAssistantRequestPayloadText(body: string): AssistantRequestPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    throw new AssistantInvalidJsonError();
  }

  if (!(parsed && typeof parsed === 'object')) {
    return { data: undefined, rawMessages: [], runConfig: undefined };
  }

  const maybePayload = parsed as Partial<{
    data: RuntimeData;
    messages: AssistantUiMessageStrict[];
    runConfig: unknown;
  }>;
  const rawMessages = Array.isArray(maybePayload.messages) ? maybePayload.messages : [];
  return {
    data: maybePayload.data,
    rawMessages,
    runConfig: maybePayload.runConfig,
  };
}

export function hasNonEmptyAssistantPrompt(messages: readonly AgentMessage[]): boolean {
  const lastUser = messages.length > 0 ? messages.at(-1) : undefined;
  const lastText =
    lastUser?.parts.find((part: AgentMessage['parts'][number]) => part.type === 'text')?.text ?? '';
  return Boolean(lastText.trim().length > 0);
}
