import type { ThreadMessage } from '@assistant-ui/react';
import { isApprovalActionMessage } from './approval-action-message';

/**
 * The turn anchor for a run leg — the id of the turn's triggering user
 * message. Every leg of one turn (initial send, approval/suspend resumes)
 * resolves the SAME id, which is what lets `createThreadRun` persist a
 * run↔turn link (BST-1163). Mirrors the desktop server's
 * `resolveTurnAnchorMessageId` (snapshot-turn-boundaries.ts) with the
 * renderer-side extra of skipping action echoes, which never reach the server.
 * `null` when the thread has no real user message.
 */
export function resolveTurnAnchorMessageId(messages: readonly ThreadMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === 'user' && !isApprovalActionMessage(candidate)) {
      return candidate.id;
    }
  }
  return null;
}
