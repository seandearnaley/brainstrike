import type {
  AgentMessage,
  AssistantRequestPayload,
  AssistantToolApprovalAction,
  AssistantUiMessageStrict as AssistantUiMessage,
  StreamChunk,
} from '@brainstrike/agent';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantAttachmentValidationError,
  AssistantInvalidJsonError,
  AssistantMessageValidationError,
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

class EmptyAssistantPromptError extends Error {}

export async function POST(req: Request): Promise<Response> {
  let bodyText: string;
  try {
    bodyText = await readAssistantRequestBodyText(req);
  } catch (error) {
    return createAssistantRequestReadErrorResponse(error);
  }

  const lastEventId = req.headers.get('last-event-id');
  const sessionFromResume = resolveDataStreamSession(lastEventId);
  if (sessionFromResume) {
    return sessionFromResume.createResponse(
      lastEventId ? { resumeFromEventId: lastEventId } : undefined
    );
  }

  let payload: AssistantRequestPayload;
  try {
    payload = parseAssistantRequestPayloadText(bodyText);
  } catch (error) {
    return createAssistantRequestReadErrorResponse(error);
  }
  // A tool-approval action resumes a SUSPENDED run (no new user turn). Validate
  // its shape here; the resume itself runs below with workflow storage, like the
  // desktop assistant server — no longer a 501 (web has in-process storage now).
  const approvalResult = readToolApprovalRunConfigAction(payload.runConfig);
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

  try {
    const agentMessages = resolveAgentMessages(payload.rawMessages, toolApprovalAction);
    const agentStream = await initializeAssistantStream({
      agentMessages,
      apiKey: provider.apiKey,
      data: payload.data,
      ...(toolApprovalAction ? { toolApprovalAction } : {}),
    });
    const session = assistantDataStreamSessions.create(agentStream);
    return session.createResponse();
  } catch (error) {
    return createAssistantExecutionErrorResponse(error);
  }
}

function jsonError(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), {
    headers: JSON_ERROR_HEADERS,
    status,
  });
}

function createAssistantInputErrorResponse(error: unknown): Response | null {
  if (error instanceof AssistantMessageValidationError) {
    return jsonError(400, error.code, error.message);
  }
  if (error instanceof AssistantAttachmentValidationError) {
    return new Response(
      JSON.stringify({
        error: 'invalid_attachment',
        message: 'Assistant attachment payload is invalid.',
        reason: error.reason,
      }),
      { headers: JSON_ERROR_HEADERS, status: 400 }
    );
  }
  return null;
}

async function readAssistantRequestBodyText(req: Request): Promise<string> {
  return await readRequestBodyText(req, assistantRequestBodyLimitBytes);
}

function createAssistantRequestReadErrorResponse(error: unknown): Response {
  if (error instanceof AssistantInvalidJsonError) {
    return jsonError(400, error.code, error.message);
  }
  if (error instanceof AssistantRequestBodyTooLargeError) {
    return jsonError(413, error.code, error.message);
  }
  const inputErrorResponse = createAssistantInputErrorResponse(error);
  if (inputErrorResponse) {
    return inputErrorResponse;
  }
  throw error;
}

function resolveAgentMessages(
  rawMessages: AssistantUiMessage[],
  toolApprovalAction: AssistantToolApprovalAction | undefined
): AgentMessage[] {
  if (toolApprovalAction) {
    return [];
  }
  const agentMessages = convertAssistantUiMessages(rawMessages);
  if (!hasNonEmptyAssistantPrompt(agentMessages)) {
    throw new EmptyAssistantPromptError();
  }
  return agentMessages;
}

async function initializeAssistantStream(options: {
  agentMessages: AgentMessage[];
  apiKey: string;
  data: unknown;
  toolApprovalAction?: AssistantToolApprovalAction;
}): Promise<AsyncIterable<StreamChunk>> {
  // The seam admits only explicit request metadata and resolves the trusted
  // permission policy; server-only runtime fields fail visibly.
  return await buildWebAssistantStream(options);
}

function createAssistantExecutionErrorResponse(error: unknown): Response {
  if (error instanceof EmptyAssistantPromptError) {
    return jsonError(400, 'empty_prompt');
  }
  const inputErrorResponse = createAssistantInputErrorResponse(error);
  if (inputErrorResponse) {
    return inputErrorResponse;
  }
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
