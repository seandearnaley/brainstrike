/**
 * DIFF-SOURCING DESIGN (BST-1116 W6 Task A): the Changes tab's file diff no
 * longer reconstructs a unified-diff string via `parseUnifiedDiff` — it
 * resolves through the shared changeset engine (`useChangeset` over the
 * `window.changes` bridge, spec §3/§7) and renders with the shared
 * `ChangesetFileDiffCard` (`../changes/ui/changeset-file-diff-card`).
 *
 * What stayed panel-owned, and why:
 *
 * - The LEFT file list (grouped Staged / Unstaged / Untracked, per-row
 *   stage/unstage buttons, the tri-state stage-all checkbox) is untouched,
 *   still driven straight off `window.git` `GitStatus.files`. The shared
 *   `ChangedFilesTree` (`../changes/ui/changed-files-tree.tsx`) groups by
 *   root → repo → worktree → directory and its checkboxes mean "which
 *   files' diffs to render" — a DIFFERENT semantic from this panel's
 *   staged-vs-unstaged tri-state, which means "which INDEX a stage/unstage
 *   action targets." Composing the panel onto that tree would either lose
 *   the staged/unstaged/untracked grouping this panel has always had, or
 *   require bolting a second, panel-local meaning onto a control whose
 *   existing meaning is load-bearing for the Changes SURFACE. Keeping two
 *   independent lists is the simpler, correct choice here.
 * - `useChangesStore` (`../changes/changes-store.ts`) is a MODULE-LEVEL
 *   zustand singleton shared with the Changes surface tab, which can be
 *   mounted at the same time as this panel. Writing this panel's selection
 *   into `selectedFileKeys` would silently clobber the Changes surface's own
 *   selection (and vice versa) — a real cross-surface interference hazard,
 *   not a hypothetical one. This file therefore never imports
 *   `changes-store.ts`, and — for the same reason — never mounts
 *   `ChangesetDiffPane` (which reads `selectedFileKeys` internally to decide
 *   which files to render). It mounts `ChangesetFileDiffCard` directly
 *   instead: a fully prop-driven leaf with no store coupling, exactly the
 *   composition seam that avoids the clobbering hazard while still reusing
 *   the shared rendering/loading machinery (lazy load, generation guard,
 *   binary/journal-expired/error branches, `DiffView`'s `structured`
 *   source).
 * - PER-ROW SCOPE PINNING: a `git-scope` changeset carries exactly one
 *   `GitScope` (`packages/types/src/changeset.ts`), and the main-process
 *   resolver picks the `StructuredFileDiffParams` mode straight from that
 *   scope — `'staged'` scope always resolves `mode: 'staged'`, `'unstaged'`
 *   scope always resolves `mode: 'unstaged'` (index vs worktree; NOT
 *   `'working'` — that conflation is the exact bug the `unstaged` mode's own
 *   doc comment in `packages/types/src/changeset.ts` records as settled and
 *   not to be reintroduced). Untracked files never appear in a `'staged'`or
 *   `'unstaged'` scope's listing at all (git has nothing indexed to diff),
 *   so `'untracked'` mode is reachable ONLY through the `'uncommitted'`
 *   scope, whose resolver re-probes each path's tracked state and picks
 *   `'untracked'` vs `'working'` per file. This panel therefore re-pins the
 *   changeset's `GitScope` to match the SELECTED ROW's own bucket — staged →
 *   `{ kind: 'staged' }`, unstaged → `{ kind: 'unstaged' }`, untracked →
 *   `{ kind: 'uncommitted' }` — every time the selection changes, so the
 *   rendered diff always matches the row the user actually clicked instead
 *   of silently drifting to a different comparison.
 * - `worktreePath` IS `repository.openedRoot`, NOT
 *   `repository.currentWorktree.path` (W6 review finding). Two independent
 *   reasons, both only visible when `repository.scope === 'workspace'` (the
 *   opened folder is BELOW the git worktree root — `GitRepository.scope`'s
 *   own doc comment): (1) the main-process resolver
 *   (`changeset-git-scope.ts`'s `resolveContainedWorktreeCwd`) requires the
 *   root resolved from `rootId` to CONTAIN `worktreePath`, and the worktree
 *   root is an ANCESTOR of the opened root in that configuration, so passing
 *   it fails every diff with `outside-roots-unsupported:`; (2) it becomes the
 *   git cwd, and this panel's own row paths come from `window.git`'s
 *   `GitStatus.files`, which `git-service.ts`'s `scopeStatusPaths` has
 *   already made relative to the OPENED root — a worktree-root cwd would
 *   diff a differently-prefixed path. `openedRoot` is exactly
 *   `realpath(resolveRootCwd(rootId))` (`git-service.ts`
 *   `createRepositorySnapshot`), so it satisfies both by construction and is
 *   identical to `currentWorktree.path` in the ordinary
 *   `scope === 'repository'` case.
 * - SELECTION SURVIVES A STAGE (W6 review finding 3). The selection is
 *   reconciled against every fresh `GitStatus` (`reconcileSelection`) so a
 *   staged row is followed into its new section instead of leaving a
 *   highlighted-nowhere selection behind, and the diff card is keyed on that
 *   section so the bucket change remounts it rather than latching the
 *   pre-stage diff. Rationales in those two symbols' own comments.
 */
import type {
  ChangedFileEntry,
  ChangedFileStatus,
  Changeset,
  GitResult,
  GitScope,
  StructuredFileDiff,
} from '@brainstrike/types';
import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  ScrollArea,
  useToast,
} from '@brainstrike/ui';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  FileMinus,
  FilePlus,
  Filter,
  Upload,
} from 'lucide-react';
import { type ReactElement, useCallback, useDeferredValue, useId, useMemo, useState } from 'react';
import {
  selectGitScopeRefreshNonce,
  useChangesLiveRefreshStore,
} from '../changes/changes-live-refresh-store';
import { ChangesetFileDiffCard } from '../changes/ui/changeset-file-diff-card';
import { useChangeset } from '../changes/use-changeset';
import { summarizeGitFailure } from '../git-failure-summary';
import { gitStatusPresentation } from '../git-status-presentation';
import type { GitRepository, GitStatus, GitStatusFile } from './git-bridge';
import type { UseGitPanelResult } from './use-git-panel';

interface SelectedFile {
  readonly originalPath?: string;
  readonly path: string;
  readonly staged: boolean;
  readonly status: string;
  readonly untracked: boolean;
}

/** Which of the three list sections a row belongs to. */
type SelectionBucket = 'staged' | 'unstaged' | 'untracked';

function bucketOf(selected: SelectedFile): SelectionBucket {
  if (selected.untracked) {
    return 'untracked';
  }
  return selected.staged ? 'staged' : 'unstaged';
}

function fileIsInBucket(file: GitStatusFile, bucket: SelectionBucket): boolean {
  if (bucket === 'untracked') {
    return file.untracked;
  }
  if (bucket === 'staged') {
    return file.staged;
  }
  return file.unstaged;
}

/**
 * Where the file lives NOW. Prefers STAYING put: a partially-staged file
 * legitimately occupies both the Staged and the Unstaged section, so a
 * refresh that leaves the clicked row in place must not relocate the
 * selection. `null` ⇒ the file is in no section at all.
 */
function resolveBucket(
  file: GitStatusFile,
  previousBucket: SelectionBucket
): SelectionBucket | null {
  if (fileIsInBucket(file, previousBucket)) {
    return previousBucket;
  }
  if (file.untracked) {
    return 'untracked';
  }
  if (file.staged) {
    return 'staged';
  }
  if (file.unstaged) {
    return 'unstaged';
  }
  return null;
}

/**
 * SELECTION RECONCILIATION (BST-1116 W6 review finding 3, half 1).
 *
 * The selection is stored as a click record — `{ path, staged, untracked }` —
 * but every stage/unstage refetches `GitStatus`, and the selected file MOVES
 * between the Staged / Unstaged / Untracked sections when it does. Left
 * unreconciled, the stored record kept pointing at a section the file had
 * already left: no row rendered as highlighted, yet the diff pane still
 * showed a selection, and the pinned scope still named the old bucket.
 *
 * JUDGMENT CALL — the file is FOLLOWED into its new section, not cleared.
 * Both are defensible; following is the less surprising one for the gesture
 * that actually causes this. A user who clicks "stage" on the file they are
 * reading has expressed interest in that file, not in that index: clearing
 * would blank the diff pane they are mid-read of and make them re-click the
 * same file in a different section to get it back — the app punishing them
 * for using its own button. Following keeps the file on screen, moves the
 * highlight to where the file now is, and re-pins the scope so the diff
 * describes the row that is now selected. The pane blanks only when there is
 * genuinely nothing left to show (the file has left `status.files`
 * entirely — committed, discarded or reverted), which is honest rather than
 * surprising.
 *
 * Derived, not stored: `selected` remains the raw click and this runs against
 * every fresh `status.files`, so there is no second source of truth to fall
 * out of sync and no reconciliation effect to order against the status load.
 */
function reconcileSelection(
  selected: SelectedFile | null,
  files: readonly GitStatusFile[]
): SelectedFile | null {
  if (!selected) {
    return null;
  }
  const file = files.find((candidate) => candidate.path === selected.path);
  if (!file) {
    return null;
  }
  const bucket = resolveBucket(file, bucketOf(selected));
  if (bucket === null) {
    return null;
  }
  // `status`/`originalPath` are re-read from the fresh row too: staging an
  // untracked file turns its porcelain letter from `?` into `A`, and that
  // letter is what labels the diff card's header.
  return {
    ...(file.originalPath ? { originalPath: file.originalPath } : {}),
    path: file.path,
    staged: bucket === 'staged',
    status: file.status,
    untracked: bucket === 'untracked',
  };
}

/** The scope a selected row's diff must be pinned to — see this module's
 * doc comment (PER-ROW SCOPE PINNING). */
function scopeForSelection(selected: SelectedFile): GitScope {
  if (selected.untracked) {
    return { kind: 'uncommitted' };
  }
  return selected.staged ? { kind: 'staged' } : { kind: 'unstaged' };
}

/** `GitStatusFile.status` is git's raw porcelain-v2 letter (untyped —
 * `packages/types/src/git.ts`); this is a display-only best-effort mapping
 * onto the shared engine's closed `ChangedFileStatus` union for
 * `ChangesetFileDiffCard`'s header label. It never gates behavior. */
function statusLetterToChangedFileStatus(status: string): ChangedFileStatus {
  switch (status) {
    case '?':
      return 'untracked';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

function partitionFiles(files: readonly GitStatusFile[]): {
  readonly staged: readonly GitStatusFile[];
  readonly unstaged: readonly GitStatusFile[];
  readonly untracked: readonly GitStatusFile[];
} {
  const staged: GitStatusFile[] = [];
  const unstaged: GitStatusFile[] = [];
  const untracked: GitStatusFile[] = [];
  for (const file of files) {
    if (file.untracked) {
      untracked.push(file);
      continue;
    }
    if (file.staged) {
      staged.push(file);
    }
    if (file.unstaged) {
      unstaged.push(file);
    }
  }
  return { staged, unstaged, untracked };
}

function ChangeFileRow({
  file,
  onSelect,
  onStage,
  selected,
  staged,
}: {
  readonly file: GitStatusFile;
  readonly onSelect: () => void;
  readonly onStage: () => void;
  readonly selected: boolean;
  readonly staged: boolean;
}): ReactElement {
  const presentation = gitStatusPresentation(file.status);
  const statusDescriptionId = useId();
  return (
    <li className="group flex min-h-9 items-center border-border/70 border-b last:border-b-0">
      <span className="sr-only" id={statusDescriptionId}>
        {presentation.label}
      </span>
      <button
        aria-current={selected ? 'true' : undefined}
        aria-describedby={statusDescriptionId}
        className={`flex min-w-0 flex-1 items-center gap-2 self-stretch px-3 text-left text-xs transition-colors hover:bg-accent/45 ${
          selected ? 'bg-primary/12 text-foreground' : 'text-foreground/90'
        }`}
        onClick={onSelect}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`w-4 shrink-0 text-center font-mono font-semibold text-[10px] ${presentation.className}`}
        >
          {presentation.glyph}
        </span>
        <span className="truncate" title={file.path}>
          {file.path}
        </span>
      </button>
      <Button
        aria-label={`${staged ? 'Unstage' : 'Stage'} ${file.path}`}
        className="mr-1 opacity-70 group-hover:opacity-100"
        onClick={onStage}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        {staged ? <FileMinus aria-hidden="true" /> : <FilePlus aria-hidden="true" />}
      </Button>
    </li>
  );
}

function ChangeSection({
  files,
  onSelect,
  onStage,
  selected,
  staged,
  title,
}: {
  readonly files: readonly GitStatusFile[];
  readonly onSelect: (file: GitStatusFile, staged: boolean) => void;
  readonly onStage: (file: GitStatusFile) => void;
  readonly selected: SelectedFile | null;
  readonly staged: boolean;
  readonly title: string;
}): ReactElement | null {
  if (files.length === 0) {
    return null;
  }
  return (
    <section>
      <h3 className="sticky top-0 z-10 border-border border-b bg-muted/85 px-3 py-1.5 font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em] backdrop-blur-sm">
        {title} ({files.length})
      </h3>
      <ul>
        {files.map((file) => (
          <ChangeFileRow
            file={file}
            key={`${title}:${file.path}`}
            onSelect={() => onSelect(file, staged)}
            onStage={() => onStage(file)}
            selected={selected?.path === file.path && selected.staged === staged}
            staged={staged}
          />
        ))}
      </ul>
    </section>
  );
}

function SyncControls({
  isSyncing,
  onPull,
  onPush,
  repository,
  status,
}: {
  readonly isSyncing: boolean;
  readonly onPull: () => void;
  readonly onPush: (remote?: string) => void;
  readonly repository: GitRepository;
  readonly status: GitStatus;
}): ReactElement {
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const fullWorktree = repository.scope === 'repository';
  return (
    <div className="flex items-center gap-1.5 border-border border-t px-2 py-2">
      <Button
        aria-label="Pull from upstream"
        className="flex-1"
        disabled={isSyncing || status.upstream === null || !fullWorktree}
        onClick={onPull}
        size="sm"
        type="button"
        variant="outline"
      >
        <Download aria-hidden="true" />
        Pull
        {behind > 0 ? (
          <Badge className="ml-1 gap-0.5" data-testid="behind-badge" variant="secondary">
            <ArrowDown aria-hidden="true" />
            {behind}
          </Badge>
        ) : null}
      </Button>
      {status.upstream ? (
        <Button
          aria-label="Push to upstream"
          className="flex-1"
          disabled={isSyncing || status.branch === null || !fullWorktree}
          onClick={() => onPush()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Upload aria-hidden="true" />
          Push
          {ahead > 0 ? (
            <Badge className="ml-1 gap-0.5" data-testid="ahead-badge" variant="secondary">
              <ArrowUp aria-hidden="true" />
              {ahead}
            </Badge>
          ) : null}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Choose remote to publish branch"
              className="flex-1"
              disabled={
                isSyncing ||
                status.branch === null ||
                !fullWorktree ||
                repository.remotes.length === 0
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <Upload aria-hidden="true" />
              Publish
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {repository.remotes.map((remote) => (
              <DropdownMenuItem key={remote} onSelect={() => onPush(remote)}>
                Publish to {remote}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function GitChangesView({
  panel,
  repository,
  status,
}: {
  readonly panel: UseGitPanelResult;
  readonly repository: GitRepository;
  readonly status: GitStatus;
}): ReactElement {
  const { toast } = useToast();
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter.trim().toLocaleLowerCase());
  const [clicked, setClicked] = useState<SelectedFile | null>(null);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');

  // The effective selection: the last click, re-resolved against the FRESH
  // status on every refresh — see `reconcileSelection`. Everything downstream
  // (row highlight, pinned scope, diff entry, card key) reads this, never the
  // raw click.
  const selected = useMemo(
    () => reconcileSelection(clicked, status.files),
    [clicked, status.files]
  );

  const filteredFiles = useMemo(
    () =>
      deferredFilter.length === 0
        ? status.files
        : status.files.filter((file) => file.path.toLocaleLowerCase().includes(deferredFilter)),
    [deferredFilter, status.files]
  );
  const buckets = useMemo(() => partitionFiles(filteredFiles), [filteredFiles]);
  const allVisibleStaged =
    filteredFiles.length > 0 &&
    filteredFiles.every((file) => file.staged && !(file.unstaged || file.untracked));
  const someVisibleStaged = filteredFiles.some((file) => file.staged);
  const { visibleStagePaths, visibleUnstagePaths } = useMemo(() => {
    const stagePaths: string[] = [];
    const unstagePaths: string[] = [];
    for (const file of filteredFiles) {
      if (file.unstaged || file.untracked) {
        stagePaths.push(file.path);
      }
      if (file.staged) {
        unstagePaths.push(file.path);
      }
    }
    return { visibleStagePaths: stagePaths, visibleUnstagePaths: unstagePaths };
  }, [filteredFiles]);
  const someStaged = status.files.some((file) => file.staged);
  const filterActive = deferredFilter.length > 0;
  const visibleFileLabel = `${filteredFiles.length} visible ${filteredFiles.length === 1 ? 'file' : 'files'}`;

  const selectFile = useCallback((file: GitStatusFile, staged: boolean) => {
    setClicked({
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      path: file.path,
      staged,
      status: file.status,
      untracked: file.untracked,
    });
  }, []);

  const commitChanges = useCallback(async () => {
    const committed = await panel.commit(summary, description);
    if (committed) {
      setSummary('');
      setDescription('');
    }
  }, [description, panel.commit, summary]);

  // The changeset is re-pinned to the SELECTED ROW's own bucket every time
  // the selection changes — see this module's doc comment (PER-ROW SCOPE
  // PINNING). `null` while nothing is selected: `useChangeset` is inert for
  // a `null` changeset (no fetch, no state churn).
  const pinnedChangeset = useMemo<Changeset | null>(() => {
    if (!selected) {
      return null;
    }
    return {
      kind: 'git-scope',
      repositoryRoot: repository.repositoryRoot,
      scope: scopeForSelection(selected),
      worktreePath: repository.openedRoot,
    };
  }, [selected, repository.repositoryRoot, repository.openedRoot]);

  const changeset = useChangeset(panel.activeRootId, pinnedChangeset);

  // Live-refresh reload signal for the mounted diff card (BST-1161, PR #2288
  // review): the pinned changeset's repositoryRoot comes from `window.git`'s
  // GitRepository (never realpath'd), so the selector's unknown-key
  // conservative fallback covers a vocabulary divergence from the inventory's
  // canonical event key — see selectGitScopeRefreshNonce's doc comment.
  const gitScopeReloadToken = useChangesLiveRefreshStore((state) =>
    pinnedChangeset?.kind === 'git-scope'
      ? selectGitScopeRefreshNonce(state, pinnedChangeset.repositoryRoot)
      : 0
  );

  // A single-entry list: this panel selects one row at a time, so there is
  // exactly one file for `ChangesetFileDiffCard` to render.
  const selectedEntry = useMemo<ChangedFileEntry | null>(() => {
    if (!selected) {
      return null;
    }
    return {
      additions: null,
      deletions: null,
      ...(selected.originalPath ? { oldPath: selected.originalPath } : {}),
      path: selected.path,
      repositoryRoot: repository.repositoryRoot,
      revertible: false,
      rootId: panel.activeRootId,
      status: statusLetterToChangedFileStatus(selected.status),
      worktreePath: repository.openedRoot,
    };
  }, [selected, repository.repositoryRoot, repository.openedRoot, panel.activeRootId]);

  // Thin toast-on-failure wrapper around `changeset.fileDiff`: the shared
  // `ChangesetFileDiffCard` already renders a visible inline error for a
  // failed load (never a silent fallback on its own), but this panel's
  // established UX also toasts every diff-load failure — matching the prior
  // `use-git-panel.ts` `loadDiff` behavior this replaces. The card still
  // receives the exact same result to render from, unchanged.
  const loadFileDiff = useCallback(
    async (path: string, rootId: string | null): Promise<GitResult<StructuredFileDiff>> => {
      const result = await changeset.fileDiff(path, rootId);
      if (!result.ok) {
        toast({
          description: summarizeGitFailure(result.error),
          title: 'Diff failed',
          variant: 'destructive',
        });
      }
      return result;
    },
    [changeset.fileDiff, toast]
  );

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[40%] min-w-80 max-w-[42rem] shrink-0 flex-col border-border border-r bg-card/15">
        <div className="flex h-11 shrink-0 items-center gap-2 border-border border-b px-2">
          <Checkbox
            aria-label={
              filterActive
                ? `Stage all ${visibleFileLabel}`
                : `Stage all ${status.files.length} changed files`
            }
            checked={allVisibleStaged ? true : someVisibleStaged ? 'indeterminate' : false}
            disabled={filteredFiles.length === 0}
            onCheckedChange={(checked) => {
              if (checked === true) {
                if (filterActive) {
                  void panel.stageFiles(visibleStagePaths);
                } else {
                  void panel.stageAll();
                }
                return;
              }
              if (filterActive) {
                void panel.unstageFiles(visibleUnstagePaths);
              } else {
                void panel.unstageAll();
              }
            }}
          />
          <div className="relative min-w-0 flex-1">
            <Filter
              aria-hidden="true"
              className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Filter changed files"
              className="h-7 pl-7 text-xs"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter changed files"
              value={filter}
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {status.files.length === 0 ? (
            <p
              className="px-6 py-10 text-center text-muted-foreground text-sm"
              data-testid="git-panel-clean"
            >
              No changes. Working tree clean.
            </p>
          ) : filteredFiles.length === 0 ? (
            <p className="px-6 py-10 text-center text-muted-foreground text-sm">
              No changed files match “{filter}”.
            </p>
          ) : (
            <>
              <ChangeSection
                files={buckets.staged}
                onSelect={selectFile}
                onStage={(file) => void panel.unstageFile(file.path)}
                selected={selected}
                staged={true}
                title="Staged"
              />
              <ChangeSection
                files={buckets.unstaged}
                onSelect={selectFile}
                onStage={(file) => void panel.stageFile(file.path)}
                selected={selected}
                staged={false}
                title="Unstaged"
              />
              <ChangeSection
                files={buckets.untracked}
                onSelect={selectFile}
                onStage={(file) => void panel.stageFile(file.path)}
                selected={selected}
                staged={false}
                title="Untracked"
              />
            </>
          )}
        </ScrollArea>

        <div className="shrink-0 border-border border-t p-2">
          <label className="sr-only" htmlFor="git-commit-summary">
            Commit summary (required)
          </label>
          <Input
            className="h-8 text-xs"
            id="git-commit-summary"
            onChange={(event) => setSummary(event.target.value)}
            placeholder="Summary (required)"
            value={summary}
          />
          <textarea
            aria-label="Commit description"
            className="mt-2 min-h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-xs outline-hidden placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description"
            value={description}
          />
          <Button
            className="mt-2 w-full"
            disabled={summary.trim().length === 0 || !someStaged}
            onClick={() => void commitChanges()}
            size="sm"
            type="button"
          >
            Commit {someStaged ? `to ${status.branch ?? 'detached HEAD'}` : 'staged files'}
          </Button>
        </div>

        <SyncControls
          isSyncing={panel.isSyncing}
          onPull={() => void panel.pull()}
          onPush={(remote) => void panel.push(remote)}
          repository={repository}
          status={status}
        />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="flex h-10 shrink-0 items-center border-border border-b bg-muted/30 px-3">
          <span className="truncate font-mono text-muted-foreground text-xs">
            {selected?.path ?? 'Working tree changes'}
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {selected && selectedEntry ? (
            <ChangesetFileDiffCard
              bodyClassName="min-h-0 flex-1"
              changesetKind="git-scope"
              className="flex min-h-0 flex-1 flex-col"
              entry={selectedEntry}
              // KEYED ON SECTION MEMBERSHIP, not path alone (BST-1116 W6
              // review finding 3, half 2). `ChangesetFileDiffCard` latches
              // `hasStarted`, so a card instance that survives a bucket change
              // would keep rendering the diff it loaded for the OLD scope —
              // after staging the selected row, a HEAD-vs-worktree diff that
              // is no longer true of the row now shown. Including the bucket
              // remounts it with a fresh generation counter, exactly as
              // `changeset-diff-pane.tsx` keys `changesetKey|changedFileKey`
              // for the same latched-card hazard across changesets.
              key={`${bucketOf(selected)}|${selected.path}`}
              loadFileDiff={loadFileDiff}
              reloadToken={gitScopeReloadToken}
            />
          ) : (
            <div className="grid h-full min-h-0 place-items-center px-8 text-center text-muted-foreground text-sm">
              <div className="max-w-sm leading-relaxed">
                Select a changed file to inspect its diff.
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
