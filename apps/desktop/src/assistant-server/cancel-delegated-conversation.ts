import type http from 'node:http';
import { cancelStoredBackgroundInvocations } from '@brainstrike/agent';
import { CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { respondJson } from '@brainstrike/assistant-service/http';
import { z } from 'zod';
import { getDatabase } from '../db-main';
import {
  completeDelegatedConversationCancellation,
  revokeDelegatedConversationAdmission,
} from './delegated-cancellation-admission';
import { joinDesktopDelegatedCancellation } from './delegated-execution-controls';
import { readRequestBody } from './http';
import { desktopAssistantServerLogger as logger } from './logger';
import { getDesktopMastraMemory } from './mastra-memory';

const id = z.string().trim().min(1).max(512);
const cancellation = z.strictObject({
  ownerResourceId: id,
  rootThreadId: id,
  scope: z.enum(['child', 'subtree']),
  threadId: id,
});

export async function handleDelegatedCancelRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let action: z.infer<typeof cancellation>;
  try {
    action = cancellation.parse(JSON.parse(await readRequestBody(req, { maxBodyBytes: 4096 })));
  } catch {
    respondJson(res, 400, {
      error: 'invalid_child_cancel',
      message: 'Child cancellation requires its exact owner, root, child and scope.',
    });
    return;
  }
  try {
    const database = await getDatabase();
    const targets = await revokeDelegatedConversationAdmission(
      database,
      action,
      action.threadId,
      action.scope === 'subtree'
    );
    await joinDesktopDelegatedCancellation(database, action, targets);
    const backing = await getDesktopMastraMemory(
      CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS
    );
    if (!backing.storage) {
      throw new Error('Native cancellation storage is unavailable.');
    }
    await cancelStoredBackgroundInvocations(
      backing.storage,
      { resourceId: action.ownerResourceId, threadId: action.rootThreadId },
      targets
    );
    await completeDelegatedConversationCancellation(database, action, targets);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(JSON.stringify({ cancelled: true, threadId: action.threadId }));
  } catch (error) {
    logger.error('Selected child cancellation did not complete', {
      error,
      threadId: action.threadId,
    });
    respondJson(res, 503, {
      error: 'child_cancel_incomplete',
      message: 'Child cancellation did not complete. The host has not acknowledged Stop.',
    });
  }
}
