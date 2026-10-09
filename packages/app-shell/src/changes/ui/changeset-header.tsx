/**
 * `ChangesetHeader` (BST-1114, W4 Task A): the Changes surface's top bar —
 * source picker, honest stats, scope provenance stated in words, and
 * capability-gated actions.
 *
 * Visual language mirrors `git-panel/git-panel.tsx` and
 * `git-panel/git-workbench-header.tsx`: same border/muted tokens, same error
 * card shape, same small ghost/outline buttons.
 *
 * PROPS: the base shape is a fixed contract (other Changes-surface pieces
 * assume it). `latestRunId`, `threadId`, `onSelectLastTurn`, and `onRetry`
 * are ADDITIVE extensions — `onRetry` is explicitly sanctioned by the task
 * brief, and `latestRunId`/`threadId`/`onSelectLastTurn` are required by
 * `ChangesetSourcePicker`'s "Last Turn" control, which this header renders;
 * there is no back-channel for the picker to get thread/run identity except
 * through here. As of BST-1115 smoke feedback, the caller (`ChangesSurface`)
 * sources `latestRunId`/`threadId` from the navigation store's STANDING
 * `activeThreadIdentity`, not the "→ Review" handoff — see that store's own
 * doc comment.
 */
import type { Changeset, ChangesetView, GitInventory } from '@brainstrike/types';
import { Button, Input } from '@brainstrike/ui';
import { GitCommitHorizontal, History, Loader2, RefreshCw, Upload } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { resolveGitBridge } from '../../git-panel/git-bridge';
import { useRewindStore } from '../rewind-store';
import { useRewindPortFor } from '../use-rewind-port-for';
import { ChangesetSourcePicker } from './changeset-source-picker';
import { describeGitScopeKind } from './git-scope-label';

export interface ChangesetHeaderProps {
  readonly changeset: Changeset | null;
  readonly error: string | null;
  readonly inventory: GitInventory | null;
  readonly inventoryError: string | null;
  /** See module doc comment — additive, required by the source picker. */
  readonly latestRunId: string | null;
  readonly loading: boolean;
  /** Additive per the task brief: retries the failed `useChangeset` load. */
  readonly onRetry?: () => void;
  /**
   * Retries the failed `useGitInventory` load. An inventory failure is the
   * MORE disabling of the two errors this header can show — it empties the
   * source picker's git scopes AND strips every worktree name/trust badge
   * from the tree, and (unlike a changeset load failure) persists for the
   * whole session since the surface stays mounted — so it gets the same
   * Retry affordance as `error`/`onRetry`, not a dead end.
   */
  readonly onRetryInventory?: () => void;
  readonly onSelectChangeset: (next: Changeset) => void;
  /** See module doc comment — additive, required by the source picker. */
  readonly onSelectLastTurn: () => void;
  readonly rootId: string | null;
  /** See module doc comment — additive, required by the source picker. */
  readonly threadId: string | null;
  readonly view: ChangesetView | null;
}

function CenteredMessage({ children }: { readonly children: string }): ReactElement {
  return (
    <div
      className="grid h-full place-items-center p-8 text-center text-muted-foreground text-sm"
      data-testid="changeset-header-no-root"
    >
      <div className="max-w-md leading-relaxed">{children}</div>
    </div>
  );
}

function findWorktreeName(
  inventory: GitInventory | null,
  repositoryRoot: string,
  worktreePath: string
): string {
  if (!inventory) {
    return worktreePath;
  }
  for (const repository of inventory.repositories) {
    if (repository.identity.repositoryRoot !== repositoryRoot) {
      continue;
    }
    for (const worktree of repository.worktrees) {
      if (worktree.path === worktreePath) {
        return worktree.name;
      }
    }
  }
  return worktreePath;
}

/**
 * Scope provenance, stated in words (settled teardown ruling — see task
 * brief). Never just an icon.
 */
function ProvenanceLine({
  changeset,
  inventory,
}: {
  readonly changeset: Changeset;
  readonly inventory: GitInventory | null;
}): ReactElement {
  if (changeset.kind === 'agent-run') {
    return (
      <p className="text-muted-foreground text-xs" data-testid="changeset-provenance">
        Agent edits only — this turn
      </p>
    );
  }
  if (changeset.kind === 'run-range') {
    return (
      <p className="text-muted-foreground text-xs" data-testid="changeset-provenance">
        Agent edits only — selected runs
      </p>
    );
  }
  const worktreeName = findWorktreeName(
    inventory,
    changeset.repositoryRoot,
    changeset.worktreePath
  );
  return (
    <p className="text-muted-foreground text-xs" data-testid="changeset-provenance">
      All working-tree changes — {describeGitScopeKind(changeset.scope)} in{' '}
      <span className="font-medium text-foreground">{worktreeName}</span>
    </p>
  );
}

function StatValue({
  nullReason,
  value,
}: {
  readonly nullReason: string;
  readonly value: number | null;
}): ReactElement {
  if (value === null) {
    return (
      <span className="font-medium text-foreground tabular-nums" title={nullReason}>
        —
      </span>
    );
  }
  return <span className="font-medium text-foreground tabular-nums">{value}</span>;
}

function StatsReadout({ view }: { readonly view: ChangesetView | null }): ReactElement {
  const notLoadedReason = 'Changeset not loaded yet';
  const journalReason = 'Line counts are not recorded for agent-edit changesets';
  const fileCount = view ? view.files.length : null;
  const additions = view ? view.totalAdditions : null;
  const deletions = view ? view.totalDeletions : null;
  const additionsReason = view === null ? notLoadedReason : journalReason;
  const deletionsReason = view === null ? notLoadedReason : journalReason;

  return (
    <div className="flex items-center gap-3 text-xs" data-testid="changeset-stats">
      <span className="flex items-center gap-1" data-testid="changeset-stat-files">
        <span className="text-muted-foreground">Files</span>
        <StatValue nullReason={notLoadedReason} value={fileCount} />
      </span>
      <span className="flex items-center gap-1" data-testid="changeset-stat-additions">
        <span className="text-muted-foreground">+</span>
        <StatValue nullReason={additionsReason} value={additions} />
      </span>
      <span className="flex items-center gap-1" data-testid="changeset-stat-deletions">
        <span className="text-muted-foreground">−</span>
        <StatValue nullReason={deletionsReason} value={deletions} />
      </span>
    </div>
  );
}

/**
 * True when the active workspace root's CURRENT worktree is the one the
 * `git-scope` changeset scopes. `window.git`'s commit/push always operate on
 * the active root's own repo — offering Commit/Push for a DIFFERENT
 * repository/worktree than the one being viewed would silently commit or
 * push the wrong tree. When it does not match, the actions stay absent
 * rather than risk that.
 *
 * SCOPED TO THE CHANGESET'S OWN REPOSITORY FIRST (review finding, BST-1114
 * PR #2274): a workspace root can hold more than one repository, or be
 * itself a linked worktree, so scanning `inventory.repositories` UNFILTERED
 * for the first worktree whose `containment` includes `rootId` can return a
 * worktree from a DIFFERENT repository than `repositoryRoot` — most
 * orderings fail closed (actions hidden), but the case where that first
 * containment match happens to equal `changeset.worktreePath` while
 * `window.git`'s `rootId`-resolved cwd is a different repo would show the
 * buttons and commit/push the wrong tree. Filtering to `repositoryRoot`
 * before scanning worktrees establishes the invariant the doc comment
 * above actually claims.
 */
function isViewingActiveWorktree(
  inventory: GitInventory | null,
  rootId: string,
  repositoryRoot: string,
  worktreePath: string
): boolean {
  if (!inventory) {
    return false;
  }
  const repository = inventory.repositories.find(
    (candidate) => candidate.identity.repositoryRoot === repositoryRoot
  );
  if (!repository) {
    return false;
  }
  for (const worktree of repository.worktrees) {
    if (worktree.containment !== 'outside-roots' && worktree.containment.includes(rootId)) {
      return worktree.path === worktreePath;
    }
  }
  return false;
}

/**
 * Commit + Push, wired directly to the EXISTING `window.git` bridge
 * (`git-panel/git-bridge.ts`) rather than through `useGitPanel` or a link to
 * the Git panel: both calls here are genuinely thin (one bridge call each,
 * no staging workflow, no branch/remote selection UI), so reusing
 * `useGitPanel`'s fuller mutation runner (toasts, transient-root retry, ahead
 * /behind bookkeeping) would be more machinery than the action needs. A
 * "just link to the Git panel" alternative was considered, but this surface
 * has no reachable navigation primitive to another page — the desktop root
 * layout owns page routing via internal state, not a router, and wiring a
 * `navigateToGit` callback through means editing `root-layout-content.tsx`,
 * which is outside this task's file list.
 */
function GitScopeActions({ rootId }: { readonly rootId: string }): ReactElement | null {
  const bridge = useMemo(() => resolveGitBridge(), []);
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<string | null>(null);

  if (!bridge) {
    // Capability gate: no `window.git` bridge (web, or a malformed bridge) —
    // absent, not a disabled stub.
    return null;
  }

  const handleCommit = async (): Promise<void> => {
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      return;
    }
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await bridge.commit(rootId, { summary: trimmed });
      if (result.ok) {
        setMessage('');
        setCommitOpen(false);
      } else {
        setCommitError(result.error);
      }
    } catch (caught) {
      setCommitError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCommitting(false);
    }
  };

  const handlePush = async (): Promise<void> => {
    setPushing(true);
    setPushError(null);
    setPushResult(null);
    try {
      const result = await bridge.push(rootId);
      if (result.ok) {
        setPushResult(result.value.output || 'Up to date.');
      } else {
        setPushError(result.error);
      }
    } catch (caught) {
      setPushError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPushing(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5" data-testid="changeset-git-scope-actions">
      {commitOpen ? (
        <span className="flex items-center gap-1">
          <Input
            aria-label="Commit message"
            className="h-7 w-48 text-xs"
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Commit message"
            value={message}
          />
          <Button
            disabled={committing || message.trim().length === 0}
            onClick={handleCommit}
            size="sm"
            type="button"
            variant="outline"
          >
            {committing ? 'Committing…' : 'Commit'}
          </Button>
          <Button
            onClick={() => {
              setCommitOpen(false);
              setCommitError(null);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setCommitOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <GitCommitHorizontal aria-hidden="true" className="size-3.5" />
          Commit
        </Button>
      )}
      <Button
        className="h-7 gap-1 px-2 text-xs"
        disabled={pushing}
        onClick={handlePush}
        size="sm"
        type="button"
        variant="outline"
      >
        <Upload aria-hidden="true" className={`size-3.5 ${pushing ? 'animate-pulse' : ''}`} />
        {pushing ? 'Pushing…' : 'Push'}
      </Button>
      {commitError ? (
        <span className="text-[11px] text-destructive" data-testid="changeset-commit-error">
          {commitError}
        </span>
      ) : null}
      {pushError ? (
        <span className="text-[11px] text-destructive" data-testid="changeset-push-error">
          {pushError}
        </span>
      ) : null}
      {pushResult ? (
        <span className="text-[11px] text-muted-foreground" data-testid="changeset-push-result">
          {pushResult}
        </span>
      ) : null}
    </div>
  );
}

/**
 * "Restore to before this" — the SECOND entry point into Conversation Rewind
 * (Amendment 1 A1.3). The user's real smoke path is turn footer → Review →
 * changeset, and that path dead-ended: there was no route from a reviewed
 * agent-run changeset to undoing it.
 *
 * BOTH IDS COME FROM THE CHANGESET ITSELF. `agent-run` and `run-range` each
 * carry their own `threadId`, so nothing here reads (or needs) the navigation
 * store's `handoffThreadIdentity`. A `git-scope` changeset carries no thread at
 * all, which is exactly why this component is not rendered for one: the action
 * is ABSENT, not disabled-with-a-guess, and no thread id is ever synthesised to
 * make the button appear (that store's own doc comment names inventing one a
 * NO SILENT FALLBACKS violation).
 *
 * The header knows a RUN and never a message; the main process resolves the
 * run's triggering message (`resolveRewindMessageForRun`) so the renderer
 * never guesses one. `composerText: null` — a run has no prompt to restore, so
 * this entry point performs no composer repopulation.
 */
function RewindFromRunAction({
  runId,
  threadId,
}: {
  readonly runId: string;
  readonly threadId: string;
}): ReactElement | null {
  const openRewind = useRewindStore((state) => state.openRewind);
  const portFor = useRewindPortFor();
  if (!portFor) {
    return null;
  }
  return (
    <Button
      className="h-7 gap-1 px-2 text-xs"
      data-testid="changeset-rewind-action"
      onClick={() =>
        openRewind({ composerText: null, port: portFor(threadId), target: { runId, threadId } })
      }
      size="sm"
      type="button"
      variant="outline"
    >
      <History aria-hidden="true" className="size-3.5" />
      Restore to before this
    </Button>
  );
}

function ChangesetActions({
  changeset,
  inventory,
  rootId,
}: {
  readonly changeset: Changeset | null;
  readonly inventory: GitInventory | null;
  readonly rootId: string;
}): ReactElement | null {
  if (!changeset) {
    return null;
  }

  if (changeset.kind === 'agent-run') {
    return <RewindFromRunAction runId={changeset.runId} threadId={changeset.threadId} />;
  }

  if (changeset.kind === 'run-range') {
    // A run-range's ANCHOR is `fromRunId` — restoring to before the range means
    // restoring to before the run it starts at.
    return <RewindFromRunAction runId={changeset.fromRunId} threadId={changeset.threadId} />;
  }

  // A `git-scope` changeset carries NO thread identity, so rewind is absent for
  // it — see `RewindFromRunAction`. (BST-1114 shipped this branch with no
  // action at all, because a runId-keyed "Undo turn" had no provider reachable
  // from this sibling page; W5's rewind replaces that dead end for the two
  // journal changeset kinds without needing `EditCheckpointContext` here.)
  if (
    isViewingActiveWorktree(inventory, rootId, changeset.repositoryRoot, changeset.worktreePath)
  ) {
    return <GitScopeActions rootId={rootId} />;
  }

  const worktreeName = findWorktreeName(
    inventory,
    changeset.repositoryRoot,
    changeset.worktreePath
  );
  return (
    <span className="text-[11px] text-muted-foreground" data-testid="changeset-actions-unavailable">
      Commit/push apply to the focused worktree only — switch focus to {worktreeName} to use them.
    </span>
  );
}

export function ChangesetHeader({
  changeset,
  error,
  inventory,
  inventoryError,
  latestRunId,
  loading,
  onRetry,
  onRetryInventory,
  onSelectChangeset,
  onSelectLastTurn,
  rootId,
  threadId,
  view,
}: ChangesetHeaderProps): ReactElement {
  if (!rootId) {
    return <CenteredMessage>Open a workspace root to review changes.</CenteredMessage>;
  }

  return (
    <div
      className="flex flex-col gap-2 border-border border-b bg-card/35 px-3 py-2"
      data-testid="changeset-header"
    >
      <div className="flex flex-wrap items-center gap-3">
        <ChangesetSourcePicker
          changeset={changeset}
          inventory={inventory}
          latestRunId={latestRunId}
          onSelectChangeset={onSelectChangeset}
          onSelectLastTurn={onSelectLastTurn}
          threadId={threadId}
        />
        <StatsReadout view={view} />
        <div className="ml-auto flex items-center gap-2">
          <ChangesetActions changeset={changeset} inventory={inventory} rootId={rootId} />
        </div>
      </div>

      {changeset ? <ProvenanceLine changeset={changeset} inventory={inventory} /> : null}

      {inventoryError ? (
        <div
          className="flex flex-col items-start gap-1.5"
          data-testid="changeset-header-inventory-error"
        >
          <p className="text-[11px] text-warning">Repository list unavailable: {inventoryError}</p>
          {onRetryInventory ? (
            <Button onClick={onRetryInventory} size="sm" type="button" variant="outline">
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div
          className="flex flex-col items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
          data-testid="changeset-header-error"
        >
          <p className="font-medium text-destructive text-xs">Could not load this changeset.</p>
          <p className="text-muted-foreground text-xs">{error}</p>
          {onRetry ? (
            <Button onClick={onRetry} size="sm" type="button" variant="outline">
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {!error && loading ? (
        <p
          className="flex items-center gap-1.5 text-muted-foreground text-xs"
          data-testid="changeset-header-loading"
        >
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          Loading changeset…
        </p>
      ) : null}

      {!(error || loading) && view && view.files.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="changeset-header-empty">
          No changes in this changeset
        </p>
      ) : null}
    </div>
  );
}
