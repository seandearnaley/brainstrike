import type http from 'node:http';
import { ASSISTANT_STREAM_RESUME_PATH } from '@brainstrike/assistant-contract';
import type { AssistantRoute } from './server-types';

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

export function resolveAssistantRoute(req: http.IncomingMessage): AssistantRoute {
  const requestPath = resolveRequestPath(req);
  if (req.method === 'GET' && (requestPath === '/assistant/status' || requestPath === '/status')) {
    return 'status';
  }
  if (req.method === 'GET' && requestPath === '/assistant/openrouter-model') {
    return 'openrouter-model';
  }
  if (req.method === 'POST' && (requestPath === '/assistant/steer' || requestPath === '/steer')) {
    return 'steer';
  }
  if (req.method === 'POST' && (requestPath === '/assistant/cancel' || requestPath === '/cancel')) {
    return 'cancel';
  }
  if (req.method === 'GET' && requestPath === ASSISTANT_STREAM_RESUME_PATH) {
    return 'resume';
  }
  if (
    req.method === 'GET' &&
    (requestPath === '/assistant/suspended-runs' || requestPath === '/suspended-runs')
  ) {
    return 'suspended-runs';
  }
  if (req.method === 'POST' && (requestPath === '/assistant' || requestPath === '/')) {
    return 'assistant';
  }
  return 'not-found';
}

export function resolveRequestPath(req: http.IncomingMessage): string {
  const rawUrl = req.url ?? '/';
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return rawUrl;
  }
}
