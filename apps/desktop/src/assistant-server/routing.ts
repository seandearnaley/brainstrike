import type http from 'node:http';
import type { AssistantRoute } from '@brainstrike/assistant-service/types';

const GET_ROUTES: ReadonlyMap<string, AssistantRoute> = new Map([
  ['/assistant/status', 'status'],
  ['/status', 'status'],
  ['/assistant/openrouter-model', 'openrouter-model'],
  ['/assistant/verify-provider', 'verify-provider'],
]);

export function resolveAssistantRoute(req: http.IncomingMessage): AssistantRoute {
  return req.method === 'GET'
    ? (GET_ROUTES.get(resolveRequestPath(req)) ?? 'not-found')
    : 'not-found';
}

function resolveRequestPath(req: http.IncomingMessage): string {
  const rawUrl = req.url ?? '/';
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return rawUrl;
  }
}
