/**
 * BST-2532: a prepared context opens with the current summary's note, a host
 * notice, when the branch has one. Tests read it as the note's own text and
 * the turns after it.
 */
import type { ModelMessage } from 'ai';
import type { HostCompactedContext } from '../../src/context-compaction.ts';
import { isHostTurnInput } from '../../src/turn-input.ts';

const NOTICE = /^<brainstrike_notice>\n[^\n]*\n\n([\s\S]*)\n<\/brainstrike_notice>$/u;

/** A message's text parts, joined. */
export function messageText(message: ModelMessage | undefined): string {
  if (!message) {
    return '';
  }
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** The note a context opens with, as the host wrote it inside its notice. */
export function compactionNoteText(messages: readonly ModelMessage[]): string | undefined {
  const first = messages[0];
  if (first?.role !== 'user' || isHostTurnInput(first)) {
    return;
  }
  return NOTICE.exec(messageText(first))?.[1];
}

/** The context as its note's text and the turns after it. */
export function readCompactedContext(
  prepared: HostCompactedContext
): HostCompactedContext & { readonly note?: string } {
  const note = compactionNoteText(prepared.messages);
  return {
    ...prepared,
    messages: note === undefined ? prepared.messages : prepared.messages.slice(1),
    ...(note === undefined ? {} : { note }),
  };
}
