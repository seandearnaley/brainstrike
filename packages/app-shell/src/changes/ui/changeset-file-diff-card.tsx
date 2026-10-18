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
 * - any failure: the actual error message plus a Retry that re-runs
 *   `loadFileDiff` for THIS file only — one file's failure never blanks the
 *   pane, because each card owns its own load state independently. (The
 *   content-era `journal-content-expired:` branch died with the journal
 *   diff engine in BST-1164 T4 — snapshot-backed changesets never evict
 *   content, so the state is unreachable and its card was removed, not left
 *   as a dead fallback.)
 * - `full` / `hunks-only` content: rendered through the shared `DiffView`
 *   via the `structured` source — never special-cased into a degraded view.
 *   `additions`/`deletions` of `null` (binary) still render as "—", never
 *   `0` (see `formatStatCount`).
 */

import type {
  ChangedFileEntry,
  Changeset,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import { Button, DiffView } from '@brainstrike/ui';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { GitFailureDetails } from '../../git-failure-details';

export interface ChangesetFileDiffCardProps {
  /**
   * Height/sizing class for the mounted `DiffView` body (the `full`/
   * `hunks-only` branch of {@link LoadedBody}) — additive prop (BST-1116 W6
   * Task A). Defaults to the original fixed `h-[420px]` sizing tuned for
   * this card's native habitat, a vertically-stacked multi-file pane
   * (`ChangesetDiffPane`). The git panel's Changes tab hosts exactly ONE
   * card filling its whole diff pane, where a fixed 420px box wastes most of
   * the available height — it passes `min-h-0 flex-1` instead, paired with
   * {@link ChangesetFileDiffCardProps.className}. Purely a presentational
   * sizing hook; does not affect load/error/binary state.
   */
  readonly bodyClassName?: string;
  readonly changesetKind: Changeset['kind'];
  /**
   * Class for this card's ROOT element — additive prop (BST-1116 W6 review
   * finding), defaulting to `undefined` so the multi-file pane renders the
   * exact markup it always did. A single-card host must pass a definite-height
   * layout here (the git panel passes `flex min-h-0 flex-1 flex-col`): the
   * root is otherwise an auto-height block, so a percentage `bodyClassName`
   * height would resolve to `auto` against it and the diff would size to its
   * own content instead of filling the pane. Making the root a flex column is
   * what gives `bodyClassName`'s `flex-1` a definite box to grow into, and
   * restores `DiffView`'s own internal scrolling (which needs a bounded
   * height) rather than growing the whole document.
   */
  readonly className?: string;
  readonly entry: ChangedFileEntry;
  /**
   * `entry.rootId` is threaded on every call (not just the surface's focused
   * root): a multi-root `agent-run` turn can edit more than one workspace
   * root in a single run, and `resolveJournalFileDiff` identifies a file by
   * `(rootId, path)` — using one surface-wide root for every card renders
   * "no journaled change" for any entry belonging to a non-focused root.
   */
  readonly loadFileDiff: (
    path: string,
    rootId: string | null
  ) => Promise<GitResult<StructuredFileDiff>>;
  /**
   * Live-refresh reload signal (BST-1161, PR #2288 review): a changed value
   * re-runs the load on a card whose FIRST load already started, so a
   * re-resolved view cannot leave an already-rendered diff body showing
   * pre-invalidation content. A card that never intersected stays lazy — its
   * eventual first load fetches fresh content anyway. Hosts with immutable
   * content (the History tab's commit diffs) simply omit it.
   */
  readonly reloadToken?: number;
}

const DEFAULT_BODY_CLASS_NAME = 'h-[420px] min-h-0';

type LoadState =
  | { readonly diff: StructuredFileDiff; readonly kind: 'loaded' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly message: string; readonly kind: 'error' };

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
      <GitFailureDetails className="" error={message} summaryClassName="text-destructive" />
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
  bodyClassName,
  diff,
  entry,
}: {
  readonly bodyClassName: string;
  readonly diff: StructuredFileDiff;
  readonly entry: ChangedFileEntry;
}): ReactElement {
  if (diff.content.kind === 'binary') {
    return <BinaryBody />;
  }
  return (
    <div className={bodyClassName} data-testid="changeset-file-diff-card-diff-view">
      <DiffView
        ariaLabel={`Diff for ${entry.path}`}
        filename={entry.path}
        source={{ diff, kind: 'structured' }}
      />
    </div>
  );
}

export function ChangesetFileDiffCard({
  bodyClassName = DEFAULT_BODY_CLASS_NAME,
  // Part of the fixed cross-task prop contract (BST-1114 W4) but not read
  // here: journal-backed changesets are deliberately NOT special-cased (see
  // this module's doc comment) — the only journal-specific handling is the
  // generic null-stat rendering every changeset already goes through.
  changesetKind: _changesetKind,
  className,
  entry,
  loadFileDiff,
  reloadToken,
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
      const result = await loadFileDiff(entry.path, entry.rootId);
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
  }, [entry.path, entry.rootId, loadFileDiff]);

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

  // Reload on a live-refresh tick — see the `reloadToken` prop doc comment.
  // Ref-compared (not a bare effect dep) so a `runLoad` identity change alone
  // never re-fires it, and gated on `hasStartedRef` so an offscreen card
  // stays lazy.
  const lastReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (lastReloadTokenRef.current === reloadToken) {
      return;
    }
    lastReloadTokenRef.current = reloadToken;
    if (hasStartedRef.current) {
      void runLoad();
    }
  }, [reloadToken, runLoad]);

  const retry = useCallback(() => {
    void runLoad();
  }, [runLoad]);

  return (
    <div className={className} data-testid="changeset-file-diff-card" ref={containerRef}>
      <CardHeader entry={entry} />
      {state.kind === 'idle' || state.kind === 'loading' ? <LoadingBody /> : null}
      {state.kind === 'error' ? <ErrorBody message={state.message} onRetry={retry} /> : null}
      {state.kind === 'loaded' ? (
        <LoadedBody bodyClassName={bodyClassName} diff={state.diff} entry={entry} />
      ) : null}
    </div>
  );
}
