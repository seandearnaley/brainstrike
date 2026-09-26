import type http from 'node:http';
import { respondJson } from '@brainstrike/assistant-service/http';
import { DelegatedConversationIdentityError } from '@brainstrike/db';
import { z } from 'zod';
import { getDatabase } from '../db-main';
import { readRequestBody } from './http';
import { desktopAssistantServerLogger as logger } from './logger';
import { refreshDelegatedFamilyColors } from './refresh-delegated-family-colors';

const requestSchema = z.strictObject({
  ownerResourceId: z.string().trim().min(1).max(512),
  rootThreadId: z.string().trim().min(1).max(512),
});

export async function handleRefreshAgentColorsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await readRequestBody(req, { maxBodyBytes: 4096 })) as unknown;
  } catch {
    input = null;
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    respondJson(res, 400, {
      error: 'invalid_agent_color_refresh',
      message: 'Select a valid root conversation to refresh agent colors.',
    });
    return;
  }
  try {
    const changed = await refreshDelegatedFamilyColors(await getDatabase(), parsed.data);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ changed }));
  } catch (error) {
    if (error instanceof DelegatedConversationIdentityError) {
      respondJson(res, 409, {
        error: 'agent_color_refresh_conflict',
        message:
          error.actionableMessage ??
          'The saved agent tree could not be verified. Reload the thread and try again.',
      });
      return;
    }
    logger.error('Saved agent color refresh failed', {
      error,
      rootThreadId: parsed.data.rootThreadId,
    });
    respondJson(res, 503, {
      error: 'agent_color_refresh_failed',
      message: 'Agent colors could not be refreshed. Try again.',
    });
  }
}
