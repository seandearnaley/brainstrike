import { GET as handleAssistantStatusRequest } from '../../src/app/api/assistant/status/route.js';
import { resolveWebAssistantDeploymentAccess } from '../../src/server/web-assistant-deployment.js';

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

export async function GET(): Promise<Response> {
  const access = resolveWebAssistantDeploymentAccess(process.env['VERCEL_ENV']);
  if (!access.enabled) {
    return new Response(
      JSON.stringify({
        enabled: false,
        reason: access.reason,
      }),
      {
        headers: JSON_HEADERS,
        status: 200,
      }
    );
  }
  return await handleAssistantStatusRequest();
}
