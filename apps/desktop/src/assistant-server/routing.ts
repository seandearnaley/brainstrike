import type http from 'node:http';

type AssistantRoute = 'status' | 'openrouter-model' | 'verify-provider' | 'not-found';
const GET_ROUTES: ReadonlyMap<string, AssistantRoute> = new Map([
  ['/assistant/status', 'status'],
  ['/status', 'status'],
  ['/assistant/openrouter-model', 'openrouter-model'],
  ['/assistant/verify-provider', 'verify-provider'],
]);

export function resolveAssistantRoute(req: http.IncomingMessage): AssistantRoute {
  if (req.method !== 'GET') {
    return 'not-found';
  }
  try {
    return GET_ROUTES.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname) ?? 'not-found';
  } catch {
    return 'not-found';
  }
}
