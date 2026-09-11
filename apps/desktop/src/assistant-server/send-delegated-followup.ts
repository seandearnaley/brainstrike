import type http from 'node:http';
import { respondJson } from '@brainstrike/assistant-service/http';
import { DelegatedConversationIdentityError } from '@brainstrike/db';
import { z } from 'zod';
import { sendDesktopDelegatedFollowup } from './delegated-followup-controls';
import { readRequestBody } from './http';
import { desktopAssistantServerLogger as logger } from './logger';

const id = z.string().trim().min(1).max(512);
const inputSchema = z.strictObject({
  hostRunId: id,
  id,
  ownerResourceId: id,
  rootThreadId: id,
  text: z.string().trim().min(1).max(32_000),
  threadId: id,
});

export async function handleDelegatedFollowupRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(JSON.parse(await readRequestBody(req, { maxBodyBytes: 140_000 })));
  } catch {
    respondJson(res, 400, {
      error: 'invalid_child_input',
      message: 'Child input requires text and its exact conversation owner.',
    });
    return;
  }
  try {
    await sendDesktopDelegatedFollowup(input.hostRunId, input, input.threadId, {
      id: input.id,
      text: input.text,
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ accepted: true, id: input.id, threadId: input.threadId }));
  } catch (error) {
    if (error instanceof DelegatedConversationIdentityError) {
      respondJson(res, 404, {
        error: 'child_input_unavailable',
        message: 'This child is no longer accepting input in the selected conversation.',
      });
      return;
    }
    logger.error('Child input delivery did not complete', { error, threadId: input.threadId });
    respondJson(res, 503, {
      error: 'child_input_incomplete',
      message:
        'Child input delivery was not confirmed. Your draft is retained; the host will not replay it automatically.',
    });
  }
}
