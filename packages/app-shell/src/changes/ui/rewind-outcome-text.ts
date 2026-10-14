import type { RewindConversationEffect } from '../rewind-port';

/** What the rewind did to the conversation, in the owner's own terms. */
export function rewindConversationOutcome(effect: RewindConversationEffect): string {
  return `${effect.turns} turn${effect.turns === 1 ? '' : 's'} left this conversation; switch back to ${effect.turns === 1 ? 'it' : 'them'} with the branch picker.`;
}
