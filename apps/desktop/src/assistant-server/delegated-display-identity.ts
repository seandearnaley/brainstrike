import { createHash } from 'node:crypto';
import { hostChildCallSign } from '@brainstrike/agent-host/child-presentation';
import { DELEGATED_CONVERSATION_COLOR_IDS, type DelegatedConversationColor } from '@brainstrike/db';

/** Display identity only: never derive ownership or ancestry from a native id. */
export function createDelegatedDisplayIdentity(threadId: string): {
  color: DelegatedConversationColor;
  displayName: string;
} {
  const digest = createHash('sha256').update(threadId).digest();
  const color =
    DELEGATED_CONVERSATION_COLOR_IDS[
      digest.readUInt16BE(2) % DELEGATED_CONVERSATION_COLOR_IDS.length
    ];
  if (!color) {
    throw new Error('Delegated conversation display palette is empty.');
  }
  // BST-1932: one call-sign owner for legacy and agent host children.
  return { color, displayName: hostChildCallSign(threadId) };
}
