import type {
  AssistantUiMessageStrict as AssistantUiMessage,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantInvalidJsonError,
  AssistantRequestBodyTooLargeError,
  assistantDataStreamSessions,
  convertAssistantUiMessages,
  hasNonEmptyAssistantPrompt,
  parseAssistantRequestPayloadText,
  resolveAssistantRequestBodyLimitBytes,
  resolveDataStreamSession,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';

const logger = createLogger('WebAssistantRoute');
const assistantRequestBodyLimitBytes = resolveAssistantRequestBodyLimitBytes(
  process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]
);

export async function POST(req: Request): Promise<Response> {
  const lastEventId = req.headers.get('last-event-id');
  const sessionFromResume = resolveDataStreamSession(lastEventId);
  if (sessionFromResume) {
    return sessionFromResume.createResponse(
      lastEventId ? { resumeFromEventId: lastEventId } : undefined
    );
  }

  let rawMessages: AssistantUiMessage[];
  let data: RuntimeData | undefined;
  try {
    const body = await readAssistantRequestText(req, assistantRequestBodyLimitBytes);
    const payload = parseAssistantRequestPayloadText(body);
    rawMessages = payload.rawMessages;
    data = payload.data;
  } catch (error) {
    if (error instanceof AssistantInvalidJsonError) {
      return jsonError(400, error.code, error.message);
    }
    if (error instanceof AssistantRequestBodyTooLargeError) {
      return jsonError(413, error.code, error.message);
    }
    throw error;
  }
  const agentMessages = convertAssistantUiMessages(rawMessages);

  const provider = resolveAssistantProviderConfig();
  if (!(provider.enabled && provider.apiKey)) {
    return new Response(
      JSON.stringify({
        error: 'assistant_disabled',
        reason: provider.disabledReason ?? 'missing_api_key',
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  if (!hasNonEmptyAssistantPrompt(agentMessages)) {
    return jsonError(400, 'empty_prompt');
  }

  let agentStream: AsyncIterable<StreamChunk>;
  try {
    agentStream = await toAiSdkStyleStream(agentMessages, {
      ...(data ?? {}),
      apiKey: provider.apiKey,
    });
  } catch (error) {
    logger.error('Failed to initialize assistant stream', { error });
    return new Response(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed',
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }

  const session = assistantDataStreamSessions.create(agentStream);
  return session.createResponse();
}

async function readAssistantRequestText(req: Request, bodyLimitBytes: number): Promise<string> {
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
    while (true) {
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
    try {
      await reader.cancel();
    } catch {}
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bodyBytes);
}

function jsonError(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
