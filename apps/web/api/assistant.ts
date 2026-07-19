import { resolveWebAssistantDeploymentAccess } from '../src/server/web-assistant-deployment';

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

export async function POST(request: Request): Promise<Response> {
  const access = resolveWebAssistantDeploymentAccess(process.env['VERCEL_ENV']);
  if (!access.enabled) {
    return new Response(
      JSON.stringify({
        error: 'assistant_disabled',
        reason: access.reason,
      }),
      {
        headers: JSON_HEADERS,
        status: 503,
      }
    );
  }
  const { POST: handleAssistantRequest } = await import('../src/app/api/assistant/route.js');
  return await handleAssistantRequest(request);
}
