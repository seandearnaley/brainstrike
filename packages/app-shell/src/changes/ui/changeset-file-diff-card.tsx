/**
 * `ChangesetFileDiffCard` (BST-1114, W4 Task C): one file's diff, rendered
 * inside the {@link ChangesetDiffPane} stack.
 *
 * Owns its own lazy load: the diff is fetched only once this card's root
 * element intersects the viewport (or immediately, as a visible-not-blank
 * fallback, when `IntersectionObserver` is unavailable — see the mount
 * effect below), never eagerly on mount for every file in a changeset. The
 * load is generation-guarded — the same discipline as
 * `use-changeset.ts`'s `loadView`/`fileDiff`: the generation counter
 * increments BEFORE the await, is captured, and every `setState` is guarded
 * against a stale resolve, so a slow first load can never clobber a newer
 * one (e.g. a Retry fired while the original request was still in flight).
 *
 * Every render branch is honest — never blank:
 * - `loading` / not-yet-visible: a real per-card loading affordance.
 * - `binary` content: an explanatory card, never an empty `DiffView`.
 * - a `journal-content-expired:` failure (the real prefix emitted by
 *   `apps/desktop/src/assistant-server/changeset-journal-view.ts`'s
 *   `resolveOldContent` — verified by reading that module, not guessed):
 *   a distinct explanatory card naming the file and stating the checkpoint
 *   content evicted from the edit-checkpoint journal, never a generic red
 *   error and never a blank pane.
 * - any other failure: the actual error message plus a Retry that re-runs
 *   `loadFileDiff` for THIS file only — one file's failure never blanks the
 *   pane, because each card owns its own load state independently.
 * - `full` / `hunks-only` content (including journal-backed changesets,
 *   which carry full old/new content but no hunks and no line counts):
 *   rendered through the shared `DiffView` via the `structured` source —
 *   never special-cased into a degraded view. The only journal-specific
 *   discipline is upstream, in `ChangedFileEntry.additions`/`.deletions`
 *   being `null` for those changesets — this card already renders `null` as
 *   "—", never `0` (see `formatStatCount`).
 */

import type {
  ChangedFileEntry,
  Changeset,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import { Button, DiffView } from '@brainstrike/ui';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';

export interface ChangesetFileDiffCardProps {
  readonly changesetKind: Changeset['kind'];
  readonly entry: ChangedFileEntry;
  readonly loadFileDiff: (path: string) => Promise<GitResult<StructuredFileDiff>>;
}

type LoadState =
  | { readonly diff: StructuredFileDiff; readonly kind: 'loaded' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly message: string; readonly kind: 'error' };

/** `journal-content-expired:` is the real error prefix `resolveOldContent`
 * emits (see this module's doc comment) — matched via `startsWith` since the
 * remainder of the message varies per cause (already-reverted chain,
 * retention-expired row, skipped binary/oversized capture, rename record). */
const JOURNAL_CONTENT_EXPIRED_PREFIX = 'journal-content-expired:';

/** `null` renders as "—", never "0" — those are different facts (not
 * computable vs. computed to exactly zero; see `ChangedFileEntry`'s doc
 * comment in `packages/types/src/changeset.ts`). */
function formatStatCount(value: number | null): string {
  return value === null ? '—' : String(value);
}

const STATUS_LABELS: Record<ChangedFileEntry['status'], string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

function displayPath(entry: ChangedFileEntry): string {
  return entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
}

function CardHeader({ entry }: { readonly entry: ChangedFileEntry }): ReactElement {
  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-2 border-border border-b bg-muted/85 px-3 py-1.5 backdrop-blur-sm"
      data-testid="changeset-file-diff-card-header"
    >
      <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
        {STATUS_LABELS[entry.status]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={displayPath(entry)}>
        {displayPath(entry)}
      </span>
      <span
        className="shrink-0 text-muted-foreground text-xs"
        data-testid="changeset-file-diff-card-stats"
      >
        <span aria-hidden="true">
          +{formatStatCount(entry.additions)} −{formatStatCount(entry.deletions)}
        </span>
        <span className="sr-only">
          {formatStatCount(entry.additions)} additions, {formatStatCount(entry.deletions)} deletions
        </span>
      </span>
    </div>
  );
}

function LoadingBody(): ReactElement {
  return (
    <div
      className="flex h-40 items-center justify-center text-muted-foreground text-xs"
      data-testid="changeset-file-diff-card-loading"
      role="status"
    >
      Loading diff…
    </div>
  );
}

function BinaryBody(): ReactElement {
  return (
    <div
      className="flex h-40 flex-col items-center justify-center gap-1 px-6 text-center text-muted-foreground text-sm"
      data-testid="changeset-file-diff-card-binary"
    >
      <span>Binary file — no textual diff available.</span>
    </div>
  );
}

function JournalContentExpiredBody({ path }: { readonly path: string }): ReactElement {
  return (
    <div
      className="flex flex-col gap-1.5 border-amber-500/30 border-b bg-amber-500/8 px-4 py-3 text-sm"
      data-testid="changeset-file-diff-card-journal-expired"
      role="status"
    >
      <p className="font-medium text-amber-700 dark:text-amber-400">
        Diff unavailable — checkpoint content expired
      </p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        The agent's recorded before/after content for <code>{path}</code> has been evicted from the
        edit-checkpoint journal, so this diff can no longer be reconstructed. The file itself is
        unaffected.
      </p>
    </div>
  );
}

function ErrorBody({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <div
      className="flex flex-col gap-2 border-destructive/30 border-b bg-destructive/5 px-4 py-3 text-sm"
      data-testid="changeset-file-diff-card-error"
      role="alert"
    >
      <p className="text-destructive">{message}</p>
      <Button className="w-fit" onClick={onRetry} size="xs" type="button" variant="outline">
        Retry
      </Button>
    </div>
  );
}

/** Renders the loaded diff's body — the ONLY branch that reaches `DiffView`.
 * Journal-backed changesets (`agent-run`/`run-range`) flow through here
 * exactly like git-scope changesets; see this module's doc comment. */
function LoadedBody({
  diff,
  entry,
}: {
  readonly diff: StructuredFileDiff;
  readonly entry: ChangedFileEntry;
}): ReactElement {
  if (diff.content.kind === 'binary') {
    return <BinaryBody />;
  }
  return (
    <div className="h-[420px] min-h-0" data-testid="changeset-file-diff-card-diff-view">
      <DiffView
        ariaLabel={`Diff for ${entry.path}`}
        filename={entry.path}
        source={{ diff, kind: 'structured' }}
      />
    </div>
  );
}

export function ChangesetFileDiffCard({
  // Part of the fixed cross-task prop contract (BST-1114 W4) but not read
  // here: journal-backed changesets are deliberately NOT special-cased (see
  // this module's doc comment) — the only journal-specific handling is the
  // generic null-stat rendering every changeset already goes through.
  changesetKind: _changesetKind,
  entry,
  loadFileDiff,
}: ChangesetFileDiffCardProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const generationRef = useRef(0);
  // Guards against firing the FIRST load twice — once the initial
  // intersection is observed, later re-observations (e.g. the observer
  // reconnecting because `runLoad`'s identity changed) must not re-trigger
  // it. A manual Retry bypasses this guard directly via `runLoad` itself.
  const hasStartedRef = useRef(false);

  const runLoad = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setState({ kind: 'loading' });
    try {
      const result = await loadFileDiff(entry.path);
      if (generation !== generationRef.current) {
        return;
      }
      setState(
        result.ok
          ? { diff: result.value, kind: 'loaded' }
          : { kind: 'error', message: result.error }
      );
    } catch (caught) {
      if (generation !== generationRef.current) {
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      setState({ kind: 'error', message });
    }
  }, [entry.path, loadFileDiff]);

  // Lazy load: fetch only once this card's element is observed intersecting
  // the viewport, calling `runLoad` directly from the observer callback
  // rather than routing through a state flag + a second effect.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      // No IO support in this environment: fail open to loading immediately
      // rather than silently never loading the diff.
      if (!hasStartedRef.current) {
        hasStartedRef.current = true;
        void runLoad();
      }
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!hasStartedRef.current && entries.some((observerEntry) => observerEntry.isIntersecting)) {
        hasStartedRef.current = true;
        void runLoad();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [runLoad]);

  const retry = useCallback(() => {
    void runLoad();
  }, [runLoad]);

  return (
    <div data-testid="changeset-file-diff-card" ref={containerRef}>
      <CardHeader entry={entry} />
      {state.kind === 'idle' || state.kind === 'loading' ? <LoadingBody /> : null}
      {state.kind === 'error' ? (
        state.message.startsWith(JOURNAL_CONTENT_EXPIRED_PREFIX) ? (
          <JournalContentExpiredBody path={entry.path} />
        ) : (
          <ErrorBody message={state.message} onRetry={retry} />
        )
      ) : null}
      {state.kind === 'loaded' ? <LoadedBody diff={state.diff} entry={entry} /> : null}
    </div>
  );
}
