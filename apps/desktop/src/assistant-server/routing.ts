import type http from 'node:http';
import {
  ASSISTANT_RUN_STATUS_PATH,
  ASSISTANT_STREAM_RESUME_PATH,
} from '@brainstrike/assistant-contract';
import type { AssistantRoute } from '@brainstrike/assistant-service/types';

export function readLastEventId(req: http.IncomingMessage): string | undefined {
  const header = req.headers['last-event-id'];
  if (!header) {
    return;
  }
  if (Array.isArray(header)) {
    return header.at(-1);
  }
  return header;
}

const GET_ROUTES: ReadonlyMap<string, AssistantRoute> = new Map([
  ['/assistant/status', 'status'],
  ['/status', 'status'],
  ['/assistant/openrouter-model', 'openrouter-model'],
  ['/assistant/verify-provider', 'verify-provider'],
  [ASSISTANT_STREAM_RESUME_PATH, 'resume'],
  ['/assistant/suspended-runs', 'suspended-runs'],
  ['/suspended-runs', 'suspended-runs'],
  [ASSISTANT_RUN_STATUS_PATH, 'run-status'],
  ['/run-status', 'run-status'],
]);

const POST_ROUTES: ReadonlyMap<string, AssistantRoute> = new Map([
  ['/assistant/steer', 'steer'],
  ['/steer', 'steer'],
  ['/assistant/cancel', 'cancel'],
  ['/assistant/cancel-child', 'cancel-child'],
  ['/assistant/child-input', 'child-input'],
  ['/assistant/decide', 'decide'],
  ['/cancel', 'cancel'],
  ['/assistant', 'assistant'],
  ['/', 'assistant'],
]);

export function resolveAssistantRoute(req: http.IncomingMessage): AssistantRoute {
  const requestPath = resolveRequestPath(req);
  const routes =
    req.method === 'GET' ? GET_ROUTES : req.method === 'POST' ? POST_ROUTES : undefined;
  return routes?.get(requestPath) ?? 'not-found';
}

function resolveRequestPath(req: http.IncomingMessage): string {
  const rawUrl = req.url ?? '/';
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return rawUrl;
  }
}
