/**
 * The Changes diff (ADR-0036): every changed file in one scroll, drawn from
 * the patches the view already carries, so it needs no request per file. A
 * file the view sent without its patch loads when it is opened.
 *
 * With `onSendComments`, a line takes a comment. Comments stay on the diff as
 * drafts until the toolbar adds them all to the active thread's message.
 *
 * With `applyAction`, each file's actions apply to a hunk, the file, or every
 * file that offers them (ADR-0036), naming each file as the view drew it, and
 * once for each root a turn's files lie in. Reverting a file asks first; one
 * action runs at a time.
 */
import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
  ChangedFileEntry,
  ChangesAction,
  ChangesActionTarget,
  ChangesFileRevision,
  StructuredFileDiff,
} from '@brainstrike/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type DiffComment,
  type DiffReviewHandle,
  toast,
} from '@brainstrike/ui';
import {
  CHANGES_ACTION_LABEL,
  CHANGES_ACTIONS,
  DiffReview,
  type DiffReviewFile,
} from '@brainstrike/ui/diff-view';
import { type ReactElement, type Ref, useMemo, useState } from 'react';
import { changedFileKey, type DraftComment, useChangesStore } from '../changes-store';

export interface ChangesetDiffPaneProps {
  /**
   * Applies an action to files of one root, resolving once the view shows its
   * result. Without it nothing applies.
   */
  readonly applyAction?:
    | ((
        action: ChangesAction,
        target: ChangesActionTarget,
        rootId: string | null
      ) => Promise<BoundaryResult<unknown>>)
    | undefined;
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
const NO_VIEWED: ReadonlyMap<string, string> = new Map();

/** "src/a.ts", or "3 files". */
function describeFiles(files: readonly ChangesFileRevision[]): string {
  const [only] = files;
  return files.length === 1 && only !== undefined ? only.path : `${files.length} files`;
}

function describeTarget(target: ChangesActionTarget): string {
  return target.kind === 'hunks' ? target.path : describeFiles(target.files);
}

function revisionOf({ path, revision }: ChangedFileEntry): ChangesFileRevision {
  return { path, revision };
}

/** One request per root the files lie in. */
interface RootRequest {
  readonly rootId: string | null;
  readonly target: ChangesActionTarget;
}

function filesByRoot(entries: readonly ChangedFileEntry[]): RootRequest[] {
  const byRoot = new Map<string | null, ChangesFileRevision[]>();
  for (const entry of entries) {
    byRoot.set(entry.rootId, [...(byRoot.get(entry.rootId) ?? []), revisionOf(entry)]);
  }
  return [...byRoot].map(([rootId, files]) => ({ rootId, target: { files, kind: 'files' } }));
}

function toReviewFile(entry: ChangedFileEntry): DiffReviewFile {
  return {
    actions: entry.actions,
    additions: entry.additions,
    deletions: entry.deletions,
    id: changedFileKey(entry),
    oldPath: entry.oldPath,
    patch: entry.patch,
    path: entry.path,
    revision: entry.revision,
    status: entry.status,
    wholeFile: entry.wholeFile,
  };
}

export function ChangesetDiffPane({
  applyAction,
  changesetKey,
  files,
  loadFileDiff,
  onSendComments,
  reviewRef,
}: ChangesetDiffPaneProps): ReactElement | null {
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const [applying, setApplying] = useState(false);
  /** The files a revert waits to be confirmed for. */
  const [reverting, setReverting] = useState<readonly ChangedFileEntry[] | null>(null);
  const drafts = useChangesStore(
    (state) => state.commentsByChangeset.get(changesetKey) ?? NO_DRAFTS
  );
  const saveComment = useChangesStore((state) => state.saveComment);
  const deleteComment = useChangesStore((state) => state.deleteComment);
  const clearComments = useChangesStore((state) => state.clearComments);
  const viewed = useChangesStore((state) => state.viewedByChangeset.get(changesetKey) ?? NO_VIEWED);
  const setViewed = useChangesStore((state) => state.setViewed);

  const reviewFiles = useMemo(() => files.map(toReviewFile), [files]);
  const comments = useMemo(() => drafts.map((draft) => draft.comment), [drafts]);
  const entryById = useMemo(
    () => new Map(files.map((entry) => [changedFileKey(entry), entry])),
    [files]
  );

  // With every file gone, drafts still need their button.
  if (files.length === 0 && drafts.length === 0) {
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

  const apply = async (action: ChangesAction, requests: readonly RootRequest[]): Promise<void> => {
    if (!applyAction) {
      return;
    }
    setApplying(true);
    try {
      for (const { rootId, target } of requests) {
        const result = await applyAction(action, target, rootId);
        if (!result.ok) {
          toast({
            description: describeBoundaryFailure(result.error),
            title: `Couldn't ${CHANGES_ACTION_LABEL[action].toLowerCase()} ${describeTarget(target)}`,
            variant: 'destructive',
          });
        }
      }
    } finally {
      setApplying(false);
    }
  };

  const applyToFiles = (action: ChangesAction, entries: readonly ChangedFileEntry[]) => {
    if (action === 'revert') {
      setReverting(entries);
    } else {
      void apply(action, filesByRoot(entries));
    }
  };

  const applyToFile = (
    action: ChangesAction,
    file: DiffReviewFile,
    hunks: readonly string[] | null
  ) => {
    const entry = entryById.get(file.id);
    if (!entry) {
      return;
    }
    if (hunks) {
      void apply(action, [
        { rootId: entry.rootId, target: { hunks, kind: 'hunks', path: entry.path } },
      ]);
    } else {
      applyToFiles(action, [entry]);
    }
  };

  const confirmRevert = () => {
    if (reverting) {
      setReverting(null);
      void apply('revert', filesByRoot(reverting));
    }
  };

  // Each toolbar action takes exactly the files that offer it.
  const toolbar = applyAction
    ? CHANGES_ACTIONS.flatMap((action) => {
        const offering = files.filter((entry) => entry.actions.includes(action));
        return offering.length > 0 ? [{ action, offering }] : [];
      })
    : [];
  const unified = diffStyle === 'unified';
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changeset-diff-pane">
      <div className="border-border flex h-9 shrink-0 items-center gap-1.5 border-b px-2">
        {toolbar.map(({ action, offering }) => (
          <Button
            disabled={applying}
            key={action}
            onClick={() => applyToFiles(action, offering)}
            size="xs"
            type="button"
            variant="ghost"
          >
            {CHANGES_ACTION_LABEL[action]} all
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
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
      </div>
      <div className="min-h-0 flex-1">
        <DiffReview
          actionsDisabled={applying}
          comments={comments}
          diffStyle={diffStyle}
          files={reviewFiles}
          key={changesetKey}
          loadFile={loadFile}
          onAction={applyAction && applyToFile}
          onComment={onSendComments && saveDraft}
          onDeleteComment={(id) => deleteComment(changesetKey, id)}
          onViewed={(file, marked) =>
            setViewed(changesetKey, file.id, marked ? file.revision : null)
          }
          ref={reviewRef}
          viewed={viewed}
        />
      </div>
      {reverting ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setReverting(null);
            }
          }}
          open
        >
          <DialogContent
            aria-describedby={undefined}
            className="sm:max-w-sm"
            hideCloseButton
            role="alertdialog"
          >
            <DialogHeader>
              <DialogTitle>Revert {describeFiles(reverting)}?</DialogTitle>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setReverting(null)} type="button" variant="outline">
                Cancel
              </Button>
              <Button onClick={confirmRevert} type="button" variant="destructive">
                Revert
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
