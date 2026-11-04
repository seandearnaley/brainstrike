/**
 * The Changes diff (ADR-0036): every changed file in one scroll, drawn from
 * the patches the view already carries, so it needs no request per file. A
 * file the view sent without its patch loads when it is opened.
 *
 * With `onSendComments`, a line takes a comment. Comments stay on the diff as
 * drafts until the toolbar adds them all to the active thread's message.
 */
import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ChangedFileEntry, StructuredFileDiff } from '@brainstrike/types';
import { Button, type DiffComment, type DiffReviewHandle } from '@brainstrike/ui';
import { DiffReview, type DiffReviewFile } from '@brainstrike/ui/diff-view';
import { type ReactElement, type Ref, useMemo, useState } from 'react';
import { changedFileKey, type DraftComment, useChangesStore } from '../changes-store';

export interface ChangesetDiffPaneProps {
  /** Identity of the changeset; the diff's folds and drafts belong to it. */
  readonly changesetKey: string;
  readonly files: readonly ChangedFileEntry[];
  /** One file's full diff; `rootId` names the root a multi-root turn edited it in. */
  readonly loadFileDiff: (
    path: string,
    rootId: string | null
  ) => Promise<BoundaryResult<StructuredFileDiff>>;
  /** Adds the drafts to a message; false keeps them. Without it the diff takes no comments. */
  readonly onSendComments?: ((drafts: readonly DraftComment[]) => boolean) | undefined;
  readonly reviewRef?: Ref<DiffReviewHandle> | undefined;
}

const NO_DRAFTS: readonly DraftComment[] = [];

function toReviewFile(entry: ChangedFileEntry): DiffReviewFile {
  return {
    additions: entry.additions,
    deletions: entry.deletions,
    id: changedFileKey(entry),
    oldPath: entry.oldPath,
    patch: entry.patch,
    path: entry.path,
    status: entry.status,
  };
}

export function ChangesetDiffPane({
  changesetKey,
  files,
  loadFileDiff,
  onSendComments,
  reviewRef,
}: ChangesetDiffPaneProps): ReactElement | null {
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const drafts = useChangesStore(
    (state) => state.commentsByChangeset.get(changesetKey) ?? NO_DRAFTS
  );
  const saveComment = useChangesStore((state) => state.saveComment);
  const deleteComment = useChangesStore((state) => state.deleteComment);
  const clearComments = useChangesStore((state) => state.clearComments);

  const reviewFiles = useMemo(() => files.map(toReviewFile), [files]);
  const comments = useMemo(() => drafts.map((draft) => draft.comment), [drafts]);
  const entryById = useMemo(
    () => new Map(files.map((entry) => [changedFileKey(entry), entry])),
    [files]
  );

  if (files.length === 0) {
    return null;
  }

  const loadFile = async (id: string): Promise<StructuredFileDiff> => {
    const entry = entryById.get(id);
    if (!entry) {
      throw new Error('The file is no longer in this changeset.');
    }
    const result = await loadFileDiff(entry.path, entry.rootId);
    if (!result.ok) {
      throw new Error(describeBoundaryFailure(result.error));
    }
    return result.value;
  };

  const sendComments = () => {
    if (onSendComments?.(drafts)) {
      clearComments(changesetKey);
    }
  };

  const saveDraft = (comment: DiffComment) => {
    const entry = entryById.get(comment.fileId);
    if (entry) {
      saveComment(changesetKey, { comment, entry });
    }
  };

  const unified = diffStyle === 'unified';
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changeset-diff-pane">
      <div className="border-border flex h-9 shrink-0 items-center justify-end gap-1.5 border-b px-2">
        {onSendComments && drafts.length > 0 ? (
          <Button
            data-testid="changeset-diff-pane-send-comments"
            onClick={sendComments}
            size="xs"
            type="button"
          >
            Add {drafts.length} {drafts.length === 1 ? 'comment' : 'comments'} to message
          </Button>
        ) : null}
        <Button
          aria-pressed={unified}
          data-testid="changeset-diff-pane-mode"
          onClick={() => setDiffStyle(unified ? 'split' : 'unified')}
          size="xs"
          type="button"
          variant={unified ? 'secondary' : 'ghost'}
        >
          Inline
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <DiffReview
          comments={comments}
          diffStyle={diffStyle}
          files={reviewFiles}
          key={changesetKey}
          loadFile={loadFile}
          onComment={onSendComments && saveDraft}
          onDeleteComment={(id) => deleteComment(changesetKey, id)}
          ref={reviewRef}
        />
      </div>
    </div>
  );
}
