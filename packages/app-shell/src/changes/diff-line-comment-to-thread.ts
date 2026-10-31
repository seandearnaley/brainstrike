/**
 * BST-2334: a line comment from the Changes diff goes into the active
 * thread's next message, through the composer command store that owns the
 * draft (the path "Attach to thread" takes). Each comment is one block, and
 * the composer joins appended text with a blank line, so several comments
 * read as one message that the person edits and sends.
 */
import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import type { ChangedFileEntry } from '@brainstrike/types';
import type { DiffLineComment } from '@brainstrike/ui';
import { toast } from '@brainstrike/ui/use-toast';

import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';

export interface DiffLineCommentSource {
  readonly comment: DiffLineComment;
  readonly entry: Pick<ChangedFileEntry, 'oldPath' | 'path'>;
  /** The file's workspace folder, when it has a name to show. */
  readonly rootLabel?: string | undefined;
}

/** The longest run of backticks in `text`, so a fence around it cannot close early. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return longest;
}

/**
 * "`src/a.ts` in app, lines 12–14:", the quoted lines, then the comment. An
 * old-side comment names the old version, and the old path of a rename.
 */
export function formatDiffLineComment({
  comment,
  entry,
  rootLabel,
}: DiffLineCommentSource): string {
  const original = comment.side === 'original';
  const path = original ? (entry.oldPath ?? entry.path) : entry.path;
  const lines =
    comment.startLine === comment.endLine
      ? `line ${comment.startLine}`
      : `lines ${comment.startLine}–${comment.endLine}`;
  const code = comment.lines.join('\n');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
  return [
    `\`${path}\`${rootLabel ? ` in ${rootLabel}` : ''}, ${lines}${original ? ' of the old version' : ''}:`,
    fence,
    code,
    fence,
    comment.text,
  ].join('\n');
}

/**
 * Adds a comment to the active thread's message. With no active thread it
 * says so and returns false, so the comment box keeps the text.
 */
export function useDiffLineCommentToThread(
  rootLabelById: ReadonlyMap<string, string>
): (entry: ChangedFileEntry, comment: DiffLineComment) => boolean {
  const threadId = useActiveAssistantThreadId();
  return (entry, comment) => {
    if (!threadId) {
      toast({
        description: 'Open or start a thread, then add the comment again.',
        title: 'No active thread',
        variant: 'destructive',
      });
      return false;
    }
    const rootLabel = entry.rootId === null ? undefined : rootLabelById.get(entry.rootId);
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'append',
      text: formatDiffLineComment({ comment, entry, rootLabel }),
      threadId,
    });
    return true;
  };
}
