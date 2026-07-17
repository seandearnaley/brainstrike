import type { AgentMessage, AssistantUiMessageStrict, RuntimeData } from './types';

export const ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR =
  'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES';
/**
 * Default request body cap. Sized against the attachment contract: the 10MB
 * combined per-message attachment cap base64-encodes to ~13.4MB, leaving
 * prompt/history headroom. The UI transport keeps that sizing true on EVERY
 * turn by bounding the whole request's inline images to the same combined cap
 * (packages/ui data-stream-runtime `boundResentImageHistory` elides older
 * history image bodies newest-first, loudly). Overridable via
 * BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES; overflow throws loudly.
 */
export const DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export interface AssistantRequestPayload {
  assistantMessageId?: string;
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
    // biome-ignore lint/style/useNamingConvention: assistant-ui transport field.
    unstable_assistantMessageId: unknown;
  }>;
  const assistantMessageId = maybePayload.unstable_assistantMessageId;
  if (
    assistantMessageId !== undefined &&
    (typeof assistantMessageId !== 'string' || assistantMessageId.trim().length === 0)
  ) {
    throw new Error('Assistant message id must be a non-empty string.');
  }
  const rawMessages = Array.isArray(maybePayload.messages) ? maybePayload.messages : [];
  return {
    data: maybePayload.data,
    rawMessages,
    runConfig: maybePayload.runConfig,
    ...(typeof assistantMessageId === 'string' ? { assistantMessageId } : {}),
  };
}

export function hasNonEmptyAssistantPrompt(messages: readonly AgentMessage[]): boolean {
  const lastUser = messages.length > 0 ? messages.at(-1) : undefined;
  const lastText =
    lastUser?.parts.find((part: AgentMessage['parts'][number]) => part.type === 'text')?.text ?? '';
  return Boolean(lastText.trim().length > 0);
}
