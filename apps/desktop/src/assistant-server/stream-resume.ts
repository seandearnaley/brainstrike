import type http from 'node:http';
import { resolveDataStreamSession } from '@brainstrike/agent';
import { streamResponse } from './http';
import { respondJson } from './http-responses';
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
  respondJson(res, 404, {
    error: 'assistant_stream_unavailable',
    message: 'The assistant stream is no longer available for replay.',
  });
}
