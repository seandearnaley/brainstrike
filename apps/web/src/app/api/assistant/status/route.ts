import { resolveAssistantProviderConfig } from '../../../../server/assistant-config';

export async function GET(): Promise<Response> {
  const provider = resolveAssistantProviderConfig();
  const enabled = Boolean(provider.enabled && provider.apiKey);
  const payload = enabled
    ? { enabled }
    : {
        enabled,
        reason: provider.disabledReason ?? 'missing_api_key',
      };

  return new Response(JSON.stringify(payload), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
    status: 200,
  });
}
