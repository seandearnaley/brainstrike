import type {
  AgentMessage,
  AssistantUiMessageStrict as AssistantUiMessage,
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
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';
import { InvalidWebAssistantRuntimeDataError } from '../../../server/web-assistant-runtime';
import { buildWebAssistantStream } from '../../../server/web-mastra-storage';

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
  let data: unknown;
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
  // A tool-approval action resumes a SUSPENDED run (no new user turn). Validate
  // its shape here; the resume itself runs below with workflow storage, like the
  // desktop assistant server — no longer a 501 (web has in-process storage now).
  const approvalResult = readToolApprovalRunConfigAction(runConfig);
  if (approvalResult && 'invalid' in approvalResult) {
    return jsonError(
      400,
      'invalid_tool_approval_action',
      'Tool approval action must include action, runId, and toolCallId.'
    );
  }
  const toolApprovalAction = approvalResult?.action;

  const provider = resolveAssistantProviderConfig();
  if (!(provider.enabled && provider.apiKey)) {
    return new Response(
      JSON.stringify({
        error: 'assistant_disabled',
        reason: provider.disabledReason ?? 'missing_api_key',
      }),
      {
        headers: JSON_ERROR_HEADERS,
        status: 503,
      }
    );
  }

  // Only a normal turn carries user messages; the approval-resume path has none.
  let agentMessages: AgentMessage[] = [];
  if (!toolApprovalAction) {
    agentMessages = convertAssistantUiMessages(rawMessages);
    if (!hasNonEmptyAssistantPrompt(agentMessages)) {
      return jsonError(400, 'empty_prompt');
    }
  }

  let agentStream: AsyncIterable<StreamChunk>;
  try {
    // The seam admits only explicit request metadata and resolves the trusted
    // permission policy; server-only runtime fields fail visibly.
    agentStream = await buildWebAssistantStream({
      agentMessages,
      apiKey: provider.apiKey,
      data,
      ...(toolApprovalAction ? { toolApprovalAction } : {}),
    });
  } catch (error) {
    if (error instanceof InvalidWebAssistantRuntimeDataError) {
      return jsonError(400, 'invalid_runtime_data', error.message);
    }
    logger.error('Failed to initialize assistant stream', { error });
    return new Response(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed',
      }),
      {
        headers: JSON_ERROR_HEADERS,
        status: 502,
      }
    );
  }

  const session = assistantDataStreamSessions.create(agentStream);
  return session.createResponse();
}

function jsonError(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), {
    headers: JSON_ERROR_HEADERS,
    status,
  });
}
