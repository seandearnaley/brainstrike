/** The comment box `DiffView` portals into an open line comment's widget (BST-2333). */
import { type KeyboardEvent, type ReactElement, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../button';
import { ExpandableTextarea } from '../expandable-textarea';
import {
  type DiffLineCommentHandler,
  describeDiffLineTarget,
  type LineCommentController,
  type OpenLineComment,
} from './diff-view-line-comments';

/**
 * The open box's form, rendered into its widget while CodeMirror draws it.
 * The form, and the draft in it, last as long as the box is open.
 */
export function LineCommentBox(props: {
  readonly controller: LineCommentController;
  readonly onLineComment: DiffLineCommentHandler | undefined;
  readonly open: OpenLineComment | null;
}): ReactElement | null {
  const { onLineComment, open } = props;
  return open && onLineComment ? (
    <OpenLineCommentForm controller={props.controller} onLineComment={onLineComment} open={open} />
  ) : null;
}

function OpenLineCommentForm({
  controller,
  onLineComment,
  open,
}: {
  readonly controller: LineCommentController;
  readonly onLineComment: DiffLineCommentHandler;
  readonly open: OpenLineComment;
}): ReactElement | null {
  const [text, setText] = useState('');
  const focused = useRef(false);
  const description = describeDiffLineTarget(open.target);

  // Focus goes to the box when it opens, not each time it scrolls back in.
  const focusOnce = (box: HTMLDivElement | null): void => {
    if (box && !focused.current) {
      focused.current = true;
      box.querySelector('textarea')?.focus();
    }
  };

  const submit = (): void => {
    const comment = text.trim();
    if (comment && onLineComment({ ...open.target, text: comment })) {
      controller.close();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      controller.close();
    }
  };

  if (!open.host) {
    return null;
  }
  return createPortal(
    // Narrow enough for one side of a split diff: the label wraps above the
    // box and the buttons wrap below it.
    <div
      className="border-border bg-background mx-1 my-1 flex min-w-0 flex-col gap-1.5 rounded-md border p-2 font-sans whitespace-normal"
      data-testid="diff-line-comment-box"
      ref={focusOnce}
    >
      <p className="text-muted-foreground text-xs">Comment on {description}</p>
      <ExpandableTextarea
        aria-label={`Comment on ${description}`}
        minRows={2}
        onChange={setText}
        onKeyDown={onKeyDown}
        placeholder="⌘/Ctrl+Enter to comment"
        value={text}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button onClick={controller.close} size="xs" type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!text.trim()} onClick={submit} size="xs" type="button">
          Comment
        </Button>
      </div>
    </div>,
    open.host
  );
}
