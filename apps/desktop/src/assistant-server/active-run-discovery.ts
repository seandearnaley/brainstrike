import type http from 'node:http';
import { assistantDataStreamSessions } from '@brainstrike/agent';
import type { AssistantActiveRunDiscoveryResponse } from '@brainstrike/assistant-contract/assistant-stream-session';
import { respondJson } from '@brainstrike/assistant-service/http';

const initializing = new Map<string, number>();

function respondDiscovery(
  res: http.ServerResponse,
  payload: AssistantActiveRunDiscoveryResponse
): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify(payload));
}

function scopeKey(resourceId: string, threadId: string): string {
  return JSON.stringify([resourceId, threadId]);
}

/** Retain accepted requests until their replay session exists or initialization fails. */
export function registerInitializingAssistantRun(resourceId: string, threadId: string): () => void {
  const key = scopeKey(resourceId, threadId);
  initializing.set(key, (initializing.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const count = initializing.get(key);
    if (count === undefined || count <= 1) {
      initializing.delete(key);
      return;
    }
    initializing.set(key, count - 1);
  };
}

export function handleActiveRunDiscoveryRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const resourceIds = url.searchParams.getAll('resourceId');
  const threadIds = url.searchParams.getAll('threadId');
  if (
    resourceIds.length !== 1 ||
    threadIds.length !== 1 ||
    !resourceIds[0]?.trim() ||
    !threadIds[0]?.trim() ||
    resourceIds[0].length > 512 ||
    threadIds[0].length > 512
  ) {
    respondJson(res, 400, {
      error: 'invalid_active_run_scope',
      message: 'Active run discovery requires one resourceId and one threadId.',
    });
    return;
  }
  const resourceId = resourceIds[0];
  const threadId = threadIds[0];
  const activeRun = assistantDataStreamSessions.findLatestByScope(resourceId, threadId);
  if (activeRun?.state === 'active') {
    respondDiscovery(res, { activeRun });
    return;
  }
  if (initializing.has(scopeKey(resourceId, threadId))) {
    respondDiscovery(res, { activeRun: null, initializing: true });
    return;
  }
  respondDiscovery(res, { activeRun });
}
