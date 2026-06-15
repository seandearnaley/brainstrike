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
  readRequestBodyText,
  readToolApprovalRunConfigAction,
  resolveAssistantRequestBodyLimitBytes,
  resolveDataStreamSession,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';

const logger = createLogger('WebAssistantRoute');
const JSON_ERROR_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;
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
  let runConfig: unknown;
  try {
    const body = await readRequestBodyText(req, assistantRequestBodyLimitBytes);
    const payload = parseAssistantRequestPayloadText(body);
    rawMessages = payload.rawMessages;
    data = payload.data;
    runConfig = payload.runConfig;
  } catch (error) {
    if (error instanceof AssistantInvalidJsonError) {
      return jsonError(400, error.code, error.message);
    }
    if (error instanceof AssistantRequestBodyTooLargeError) {
      return jsonError(413, error.code, error.message);
    }
    throw error;
  }
  const toolApprovalResponse = resolveToolApprovalResponse(runConfig);
  if (toolApprovalResponse) {
    return toolApprovalResponse;
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
        headers: JSON_ERROR_HEADERS,
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
        headers: JSON_ERROR_HEADERS,
      }
    );
  }

  const session = assistantDataStreamSessions.create(agentStream);
  return session.createResponse();
}

function resolveToolApprovalResponse(runConfig: unknown): Response | undefined {
  const toolApprovalAction = readToolApprovalRunConfigAction(runConfig);
  if (!toolApprovalAction) {
    return;
  }

  if ('invalid' in toolApprovalAction) {
    return new Response(
      JSON.stringify({
        error: 'invalid_tool_approval_action',
        message: 'Tool approval action must include action, runId, and toolCallId.',
      }),
      {
        status: 400,
        headers: JSON_ERROR_HEADERS,
      }
    );
  }

  return new Response(
    JSON.stringify({
      error: 'tool_approval_resume_unsupported',
      message: 'Tool approval resume requires the desktop assistant backend.',
    }),
    {
      status: 501,
      headers: JSON_ERROR_HEADERS,
    }
  );
}

function jsonError(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), {
    status,
    headers: JSON_ERROR_HEADERS,
  });
}
