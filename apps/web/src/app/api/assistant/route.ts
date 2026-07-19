import type { AgentMessage, StreamChunk } from '@brainstrike/agent/hosted-web';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  createStatelessAssistantDataStreamResponse,
  readRequestBodyText,
} from '@brainstrike/agent/hosted-web';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';
import { resolveWebAssistantRequestBodyLimitBytes } from '../../../server/web-assistant-body-limit';
import {
  describeWebAssistantInputError,
  resolveWebAssistantTurn,
  WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE,
  WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE,
  type WebAssistantInputError,
} from '../../../server/web-assistant-request';
import { InvalidWebAssistantRuntimeDataError } from '../../../server/web-assistant-runtime';
import { buildWebAssistantStream } from '../../../server/web-assistant-stream';

const logger = createLogger('WebAssistantRoute');
const JSON_ERROR_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;
const assistantRequestBodyLimitBytes = resolveWebAssistantRequestBodyLimitBytes(
  process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]
);

export async function POST(req: Request): Promise<Response> {
  let bodyText: string;
  try {
    bodyText = await readAssistantRequestBodyText(req);
  } catch (error) {
    return createAssistantRequestReadErrorResponse(error);
  }

  const lastEventId = req.headers.get('last-event-id');
  if (lastEventId) {
    return jsonError(
      409,
      WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE.error,
      WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE.message
    );
  }

  let turn: ReturnType<typeof resolveWebAssistantTurn>;
  try {
    turn = resolveWebAssistantTurn(bodyText);
  } catch (error) {
    return createAssistantRequestReadErrorResponse(error);
  }
  if (turn.toolApprovalAction) {
    return jsonError(
      409,
      'tool_approval_unavailable',
      'Hosted Web tool approval requires durable workflow storage.'
    );
  }
  if (turn.toolResumeAction) {
    return jsonError(
      409,
      'tool_resume_unavailable',
      'Hosted Web tool resume requires durable workflow storage.'
    );
  }

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
    const agentStream = await initializeAssistantStream({
      agentMessages: turn.agentMessages,
      apiKey: provider.apiKey,
      data: turn.payload.data,
      signal: req.signal,
    });
    return createStatelessAssistantDataStreamResponse(agentStream);
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

async function readAssistantRequestBodyText(req: Request): Promise<string> {
  return await readRequestBodyText(req, assistantRequestBodyLimitBytes);
}

function createAssistantRequestReadErrorResponse(error: unknown): Response {
  const inputError = describeWebAssistantInputError(error);
  if (inputError) {
    return createAssistantInputErrorResponse(inputError);
  }
  throw error;
}

function createAssistantInputErrorResponse(error: WebAssistantInputError): Response {
  return new Response(JSON.stringify(error.payload), {
    headers: JSON_ERROR_HEADERS,
    status: error.status,
  });
}

async function initializeAssistantStream(options: {
  agentMessages: AgentMessage[];
  apiKey: string;
  data: unknown;
  signal: AbortSignal;
}): Promise<AsyncIterable<StreamChunk>> {
  // The seam admits only explicit request metadata. Hosted Web has no tool
  // registry, so permission-policy and server-only runtime fields fail visibly.
  return await buildWebAssistantStream(options);
}

function createAssistantExecutionErrorResponse(error: unknown): Response {
  const inputError = describeWebAssistantInputError(error);
  if (inputError) {
    return createAssistantInputErrorResponse(inputError);
  }
  if (error instanceof InvalidWebAssistantRuntimeDataError) {
    return jsonError(400, 'invalid_runtime_data', error.message);
  }
  logger.error('Failed to initialize assistant stream', { error });
  return new Response(JSON.stringify(WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE.payload), {
    headers: JSON_ERROR_HEADERS,
    status: WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE.status,
  });
}
