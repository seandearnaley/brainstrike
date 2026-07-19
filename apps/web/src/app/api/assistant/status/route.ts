import { ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR } from '@brainstrike/agent/request-boundary';
import { resolveAssistantProviderConfig } from '../../../../server/assistant-config';
import {
  isWebAssistantRequestBodyLimitConfigError,
  resolveWebAssistantRequestBodyLimitBytes,
  WEB_ASSISTANT_INVALID_REQUEST_BODY_LIMIT_REASON,
} from '../../../../server/web-assistant-body-limit';

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

  const provider = resolveAssistantProviderConfig();
  const enabled = Boolean(provider.enabled && provider.apiKey);
  const payload = enabled
    ? { enabled }
    : {
        enabled,
        reason: provider.disabledReason ?? 'missing_api_key',
      };

  return createStatusResponse(payload);
}

function createStatusResponse(payload: { enabled: boolean; reason?: string }): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
    status: 200,
  });
}
