/**
 * Draft comments from a Changes diff go into the active thread's next
 * message, through the composer command store that owns the draft (the path
 * "Attach to thread" takes). Each comment is one block, joined by blank lines,
 * so several read as one message that the person edits and sends.
 */
import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import type { ChangedFileEntry } from '@brainstrike/types';
import type { DiffComment } from '@brainstrike/ui';
import { toast } from '@brainstrike/ui/use-toast';

import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import type { DraftComment } from './changes-store';

export interface DiffCommentSource {
  readonly comment: Pick<DiffComment, 'endLine' | 'lines' | 'side' | 'startLine' | 'text'>;
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
export function formatDiffLineComment({ comment, entry, rootLabel }: DiffCommentSource): string {
  const old = comment.side === 'deletions';
  const path = old ? (entry.oldPath ?? entry.path) : entry.path;
  const lines =
    comment.startLine === comment.endLine
      ? `line ${comment.startLine}`
      : `lines ${comment.startLine}–${comment.endLine}`;
  const code = comment.lines.join('\n');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
  return [
    `\`${path}\`${rootLabel ? ` in ${rootLabel}` : ''}, ${lines}${old ? ' of the old version' : ''}:`,
    fence,
    code,
    fence,
    comment.text,
  ].join('\n');
}

/**
 * Adds the comments to the active thread's message. With no active thread it
 * says so and returns false, so the drafts stay on the diff.
 */
export function useDiffCommentsToThread(
  rootLabelById: ReadonlyMap<string, string>
): (comments: readonly DraftComment[]) => boolean {
  const threadId = useActiveAssistantThreadId();
  return (comments) => {
    if (!threadId) {
      toast({
        description: 'Open or start a thread, then add the comments again.',
        title: 'No active thread',
        variant: 'destructive',
      });
      return false;
    }
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'append',
      text: comments
        .map(({ comment, entry }) =>
          formatDiffLineComment({
            comment,
            entry,
            rootLabel: entry.rootId === null ? undefined : rootLabelById.get(entry.rootId),
          })
        )
        .join('\n\n'),
      threadId,
    });
    return true;
  };
}
