import { ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR } from '@brainstrike/agent/request-boundary';
import { resolveHostedWebAssistantStatus } from '../../../../server/assistant-config.js';
import {
  isWebAssistantRequestBodyLimitConfigError,
  resolveWebAssistantRequestBodyLimitBytes,
  WEB_ASSISTANT_INVALID_REQUEST_BODY_LIMIT_REASON,
} from '../../../../server/web-assistant-body-limit.js';

export async function GET(): Promise<Response> {
  try {
    resolveWebAssistantRequestBodyLimitBytes(process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]);
  } catch (error) {
    if (!isWebAssistantRequestBodyLimitConfigError(error)) {
      throw error;
    }
    return createStatusResponse({
      enabled: false,
      reason: WEB_ASSISTANT_INVALID_REQUEST_BODY_LIMIT_REASON,
    });
  }

  return createStatusResponse(resolveHostedWebAssistantStatus());
}

function createStatusResponse(
  payload:
    | ReturnType<typeof resolveHostedWebAssistantStatus>
    | { enabled: false; reason: 'invalid_request_body_limit_config' }
): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
    status: 200,
  });
}
