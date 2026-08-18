import type http from 'node:http';
import { resolveDataStreamSession } from '@brainstrike/agent';
import { respondJson } from '@brainstrike/assistant-service/http';
import { streamResponse } from './http';
import { desktopAssistantServerLogger as logger } from './logger';
import { readLastEventId } from './routing';

export async function resumeStreamIfAvailable(
  res: http.ServerResponse,
  lastEventId: string | undefined
): Promise<boolean> {
  const session = resolveDataStreamSession(lastEventId);
  if (!session) {
    return false;
  }

  logger.info('Resuming assistant stream', { lastEventId });
  const response = session.createResponse(
    lastEventId ? { resumeFromEventId: lastEventId } : undefined
  );
  await streamResponse(res, response, undefined);
  return true;
}

export async function handleAssistantResumeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const lastEventId = readLastEventId(req);
  if (!lastEventId) {
    respondJson(res, 400, {
      error: 'missing_assistant_event_id',
      message: 'Assistant stream resume requires a Last-Event-ID header.',
    });
    return;
  }
  if (await resumeStreamIfAvailable(res, lastEventId)) {
    return;
  }
  // Visible by contract (assistant-persistence.md): the expired-session
  // response is one of the events that releases the renderer's ephemeral
  // reattachment record, so the 404 must be observable in diagnostics — the
  // 2026-08-18 wedge investigation could not tell "expired" from "never
  // attempted" because this path logged nothing.
  logger.warn('Assistant stream resume unavailable; session expired or unknown', { lastEventId });
  respondJson(res, 404, {
    error: 'assistant_stream_unavailable',
    message: 'The assistant stream is no longer available for replay.',
  });
}
