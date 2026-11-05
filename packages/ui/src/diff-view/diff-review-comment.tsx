import { X } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Button } from '../button';
import type { DiffSide } from './diff-metadata';

/** Consecutive file lines of one side, 1-based and inclusive, and the text the diff shows for them. */
export interface DiffCommentTarget {
  readonly endLine: number;
  readonly fileId: string;
  readonly lines: readonly string[];
  readonly side: DiffSide;
  readonly startLine: number;
}

export interface DiffComment extends DiffCommentTarget {
  readonly id: string;
  readonly text: string;
}

const BOX = 'bg-background border-border mx-3 my-2 rounded-md border font-sans text-sm shadow-xs';

/** "line 12", "lines 12–14", or "old line 12". */
function describeDiffCommentTarget(target: DiffCommentTarget): string {
  const old = target.side === 'deletions' ? 'old ' : '';
  return target.startLine === target.endLine
    ? `${old}line ${target.startLine}`
    : `${old}lines ${target.startLine}–${target.endLine}`;
}

export function DiffCommentComposer({
  onCancel,
  onChange,
  onSave,
  target,
  text,
}: {
  readonly onCancel: () => void;
  readonly onChange: (text: string) => void;
  readonly onSave: () => void;
  readonly target: DiffCommentTarget;
  readonly text: string;
}): ReactElement {
  const canSave = text.trim().length > 0;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSave) {
      event.preventDefault();
      onSave();
    }
  };
  return (
    <div className={`${BOX} p-2`} data-testid="diff-comment-composer">
      <textarea
        aria-label={`Comment on ${describeDiffCommentTarget(target)}`}
        autoFocus
        className="min-h-16 w-full resize-y bg-transparent outline-none"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        value={text}
      />
      <div className="flex justify-end gap-1.5">
        <Button onClick={onCancel} size="xs" type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!canSave} onClick={onSave} size="xs" type="button">
          Comment
        </Button>
      </div>
    </div>
  );
}

export function DiffCommentNote({
  comment,
  onDelete,
  onEdit,
}: {
  readonly comment: DiffComment;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
}): ReactElement {
  return (
    <div className={`${BOX} flex items-start gap-1 py-1 pr-1 pl-3`} data-testid="diff-comment">
      <button
        className="min-w-0 flex-1 cursor-text py-1 text-left whitespace-pre-wrap"
        onClick={onEdit}
        type="button"
      >
        {comment.text}
      </button>
      <Button
        aria-label="Delete comment"
        onClick={onDelete}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <X />
      </Button>
    </div>
  );
}
