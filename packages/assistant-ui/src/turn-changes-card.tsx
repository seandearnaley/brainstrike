import { useAuiState } from '@assistant-ui/react';
import type { ChangedFileEntry, ChangesetView, StructuredFileDiff } from '@brainstrike/types';
import { Button, useNearViewport } from '@brainstrike/ui';
import type { DiffReviewFile } from '@brainstrike/ui/diff-view';
import { lazy, type ReactElement, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { type ChangesReviewContextValue, useChangesReviewContext } from './changes-review-context';
import { useEditCheckpointEntries } from './edit-checkpoint-context';
import { selectFinishedRunId } from './run-verdict-control';

// The diff renderer loads with the first turn that changed files, not with the chat.
const DiffReview = lazy(() =>
  import('@brainstrike/ui/diff-view').then((m) => ({ default: m.DiffReview }))
);

type Load =
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'loaded'; readonly view: ChangesetView }
  | { readonly kind: 'loading' };

/** Two roots can share a relative path, so a file is its root and path. */
function fileId(entry: ChangedFileEntry): string {
  return `${entry.rootId ?? ''}\u0000${entry.path}`;
}

function toReviewFile(entry: ChangedFileEntry): DiffReviewFile {
  return {
    additions: entry.additions,
    deletions: entry.deletions,
    id: fileId(entry),
    oldPath: entry.oldPath,
    patch: entry.patch,
    path: entry.path,
    status: entry.status,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Totals({ view }: { readonly view: ChangesetView }): ReactElement | null {
  const { totalAdditions: additions, totalDeletions: deletions } = view;
  if (additions === null || deletions === null) {
    return null;
  }
  return (
    <span className="font-mono tabular-nums">
      <span aria-hidden="true">
        <span className="text-success">+{additions}</span>{' '}
        <span className="text-destructive">−{deletions}</span>
      </span>
      <span className="sr-only">
        {additions} additions, {deletions} deletions
      </span>
    </span>
  );
}

function ChangedFiles({
  context,
  rootId,
  runId,
  threadId,
  view,
}: {
  readonly context: ChangesReviewContextValue;
  readonly rootId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly view: ChangesetView;
}): ReactElement {
  const files = useMemo(() => view.files.map(toReviewFile), [view]);
  const entryById = useMemo(
    () => new Map(view.files.map((entry) => [fileId(entry), entry])),
    [view]
  );
  const loadFile = (id: string): Promise<StructuredFileDiff> => {
    const entry = entryById.get(id);
    return entry
      ? context.readRunFile({ rootId, runId, threadId }, entry)
      : Promise.reject(new Error('The file is no longer in this turn.'));
  };
  const count = view.files.length;
  return (
    <section
      aria-label="Changes from this turn"
      className="border-border mt-2 overflow-hidden rounded-md border"
    >
      <div className="border-border flex h-9 items-center gap-2 border-b pr-1 pl-3 text-xs">
        <span className="font-medium">
          {count} {count === 1 ? 'file' : 'files'} changed
        </span>
        <Totals view={view} />
        <Button
          className="ml-auto"
          onClick={() => context.openChangesForRun(runId, threadId)}
          size="xs"
          variant="ghost"
        >
          Review
        </Button>
      </div>
      <Suspense fallback={null}>
        {/* -mb-px: the last file's rule sits under the card's own border. */}
        <DiffReview
          className="-mb-px max-h-96 overscroll-y-auto"
          defaultCollapsed
          diffStyle="unified"
          files={files}
          loadFile={loadFile}
        />
      </Suspense>
    </section>
  );
}

function TurnChanges({
  context,
  rootId,
  runId,
  threadId,
}: {
  readonly context: ChangesReviewContextValue;
  readonly rootId: string;
  readonly runId: string;
  readonly threadId: string;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    if (!near) {
      return;
    }
    let current = true;
    context.readRunChanges({ rootId, runId, threadId }).then(
      (view) => {
        if (current) {
          setLoad({ kind: 'loaded', view });
        }
      },
      (error: unknown) => {
        if (current) {
          setLoad({ kind: 'failed', message: messageOf(error) });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [attempt, context, near, rootId, runId, threadId]);

  return (
    <div data-testid="turn-changes" ref={ref}>
      {load.kind === 'failed' ? (
        <div className="mt-2 flex items-center gap-1 text-xs">
          <span className="text-destructive" role="alert">
            Changes didn’t load. {load.message}
          </span>
          <Button
            onClick={() => {
              setLoad({ kind: 'loading' });
              setAttempt((current) => current + 1);
            }}
            size="xs"
            variant="ghost"
          >
            Retry
          </Button>
        </div>
      ) : null}
      {load.kind === 'loaded' && load.view.files.length > 0 ? (
        <ChangedFiles
          context={context}
          rootId={rootId}
          runId={runId}
          threadId={threadId}
          view={load.view}
        />
      ) : null}
    </div>
  );
}

/**
 * A finished turn's changes under its reply (ADR-0036): each file the turn
 * changed with git's counts, folded to its header until it is opened, and
 * Review to open the turn in Changes. The changes are the turn's own snapshot
 * pair, so a shell command's side effects show beside the tool edits.
 *
 * Renders nothing without a Changes binding (web, or a desktop build without
 * the bridge), before the run's terminal `run.finished` (an approval-split
 * run's earlier legs never satisfy it), without a known thread, or for a run
 * the edit journal records no edit for. A thread keeps every turn mounted, so
 * a turn's changes load only once the card comes near view (BST-2314).
 */
export function TurnChangesCard({
  threadId,
}: {
  readonly threadId: string | undefined;
}): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const runId = useMemo(() => selectFinishedRunId(parts), [parts]);
  const entries = useEditCheckpointEntries();
  const context = useChangesReviewContext();
  const rootId =
    runId === null ? undefined : entries?.find((entry) => entry.runId === runId)?.rootId;
  if (!(context && threadId && runId && rootId)) {
    return null;
  }
  return (
    <TurnChanges
      context={context}
      key={`${threadId}\u0000${runId}`}
      rootId={rootId}
      runId={runId}
      threadId={threadId}
    />
  );
}
