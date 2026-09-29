import { DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES } from '@brainstrike/assistant-contract/assistant-request-body-limit';
import { ASSISTANT_REQUEST_ENVELOPE_KEYS } from '@brainstrike/assistant-wire';
import {
  AssistantMessageValidationError,
  assertAssistantMessageGraphWithinLimits,
  MAX_ASSISTANT_MESSAGE_ID_CHARS,
} from './assistant-message-boundary';
import type { AgentMessage, AssistantUiMessageStrict, RuntimeData } from './types';

export {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantRequestBodyLimitConfigError,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  resolveAssistantRequestBodyLimitBytes,
} from '@brainstrike/assistant-contract/assistant-request-body-limit';

const ASSISTANT_REQUEST_ENVELOPE_KEY_SET = new Set<string>(ASSISTANT_REQUEST_ENVELOPE_KEYS);

export interface ParsedAssistantRequestEnvelope {
  assistantMessageId?: string;
  data: RuntimeData | undefined;
  inputParentMessageId?: string | null;
  pausedMessageId?: string;
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

export type AssistantRequestEnvelopeValidationReason =
  | 'invalid-data'
  | 'invalid-input-parent-message-id'
  | 'invalid-paused-message-id'
  | 'invalid-root'
  | 'invalid-run-config'
  | 'missing-messages'
  | 'unsupported-field';

const REQUEST_ENVELOPE_VALIDATION_MESSAGES: Record<
  AssistantRequestEnvelopeValidationReason,
  string
> = {
  'invalid-data': 'Assistant request data must be a JSON object.',
  'invalid-input-parent-message-id':
    'Assistant input parent message ID must be a valid ID or null.',
  'invalid-paused-message-id': 'Assistant paused message ID must be a valid ID.',
  'invalid-root': 'Assistant request payload must be a JSON object.',
  'invalid-run-config': 'Assistant request runConfig must be a JSON object.',
  'missing-messages': 'Assistant request payload must include its own messages array.',
  'unsupported-field': 'Assistant request payload contains an unsupported top-level field.',
};

export class AssistantRequestEnvelopeValidationError extends Error {
  readonly code = 'invalid_request_payload';

  constructor(readonly reason: AssistantRequestEnvelopeValidationReason) {
    super(REQUEST_ENVELOPE_VALIDATION_MESSAGES[reason]);
    this.name = 'AssistantRequestEnvelopeValidationError';
  }
}

export class AssistantRequestBodyTooLargeError extends Error {
  readonly code = 'request_body_too_large';

  constructor(readonly maxBodyBytes: number = DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES) {
    super(`Assistant request body exceeds ${maxBodyBytes} bytes.`);
    this.name = 'AssistantRequestBodyTooLargeError';
  }
}

export async function readRequestBodyText(
  req: Request,
  bodyLimitBytes: number = DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
): Promise<string> {
  const contentLength = req.headers.get('content-length');
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > bodyLimitBytes) {
      throw new AssistantRequestBodyTooLargeError(bodyLimitBytes);
    }
  }

  if (!req.body) {
    return '';
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > bodyLimitBytes) {
        throw new AssistantRequestBodyTooLargeError(bodyLimitBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bodyBytes);
}

function readInputParentMessageId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_ASSISTANT_MESSAGE_ID_CHARS
  ) {
    throw new AssistantRequestEnvelopeValidationError('invalid-input-parent-message-id');
  }
  return value;
}

function optionalInputParentMessageId(value: string | null | undefined): {
  inputParentMessageId?: string | null;
} {
  return value === undefined ? {} : { inputParentMessageId: value };
}

function readPausedMessageId(value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_ASSISTANT_MESSAGE_ID_CHARS
  ) {
    throw new AssistantRequestEnvelopeValidationError('invalid-paused-message-id');
  }
  return value;
}

export function parseAssistantRequestPayloadText(body: string): ParsedAssistantRequestEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AssistantInvalidJsonError();
  }

  if (!(parsed && typeof parsed === 'object') || Array.isArray(parsed)) {
    throw new AssistantRequestEnvelopeValidationError('invalid-root');
  }
  const hasUnsupportedField = Object.keys(parsed).some(
    (key) => !ASSISTANT_REQUEST_ENVELOPE_KEY_SET.has(key)
  );
  if (hasUnsupportedField) {
    throw new AssistantRequestEnvelopeValidationError('unsupported-field');
  }
  if (!Object.hasOwn(parsed, 'messages')) {
    throw new AssistantRequestEnvelopeValidationError('missing-messages');
  }

  const maybePayload = parsed as Partial<{
    data: RuntimeData;
    inputParentMessageId: unknown;
    pausedMessageId: unknown;
    messages: AssistantUiMessageStrict[];
    runConfig: unknown;
    // biome-ignore lint/style/useNamingConvention: assistant-ui transport field.
    unstable_assistantMessageId: unknown;
  }>;
  if (
    Object.hasOwn(maybePayload, 'data') &&
    !(
      maybePayload.data &&
      typeof maybePayload.data === 'object' &&
      !Array.isArray(maybePayload.data)
    )
  ) {
    throw new AssistantRequestEnvelopeValidationError('invalid-data');
  }
  if (
    Object.hasOwn(maybePayload, 'runConfig') &&
    !(
      maybePayload.runConfig &&
      typeof maybePayload.runConfig === 'object' &&
      !Array.isArray(maybePayload.runConfig)
    )
  ) {
    throw new AssistantRequestEnvelopeValidationError('invalid-run-config');
  }
  const assistantMessageId = maybePayload.unstable_assistantMessageId;
  const inputParentMessageId = readInputParentMessageId(maybePayload.inputParentMessageId);
  const pausedMessageId = readPausedMessageId(maybePayload.pausedMessageId);
  if (
    assistantMessageId !== undefined &&
    (typeof assistantMessageId !== 'string' ||
      assistantMessageId.trim().length === 0 ||
      assistantMessageId.length > MAX_ASSISTANT_MESSAGE_ID_CHARS)
  ) {
    throw new AssistantMessageValidationError('invalid-message-id');
  }
  if (maybePayload.messages !== undefined && !Array.isArray(maybePayload.messages)) {
    throw new AssistantMessageValidationError('invalid-messages');
  }
  const rawMessages = Array.isArray(maybePayload.messages) ? maybePayload.messages : [];
  assertAssistantMessageGraphWithinLimits(rawMessages);
  return {
    data: maybePayload.data,
    rawMessages,
    runConfig: maybePayload.runConfig,
    ...(typeof assistantMessageId === 'string' ? { assistantMessageId } : {}),
    ...(typeof pausedMessageId === 'string' ? { pausedMessageId } : {}),
    ...optionalInputParentMessageId(inputParentMessageId),
  };
}

export function hasAssistantPromptContent(messages: readonly AgentMessage[]): boolean {
  const finalMessage = messages.at(-1);
  if (finalMessage?.role !== 'user') {
    return false;
  }
  return finalMessage.parts.some((part: AgentMessage['parts'][number]) => {
    if (part.type === 'file') {
      return true;
    }
    if (part.type !== 'text') {
      return false;
    }
    return part.text.trim().length > 0;
  });
}
