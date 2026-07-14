import {
  Badge,
  Button,
  DiffView,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  type ParsedUnifiedDiff,
  parseUnifiedDiff,
  ScrollArea,
} from '@brainstrike/ui';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  FileMinus,
  FilePlus,
  GitBranch,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import type { GitStatusFile } from './git-bridge';
import { type LoadedDiff, useGitPanel } from './use-git-panel';

/** A file the user clicked to view; tracks whether the staged or working diff is shown. */
interface SelectedFile {
  readonly path: string;
  readonly staged: boolean;
  /** True for an untracked file → diff the whole file against /dev/null. */
  readonly untracked: boolean;
}

/** Discriminated state for the diff pane: distinguishes loading / loaded / a
 *  bridge FAILURE (already toasted) from a legitimately empty diff. */
type DiffState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; diff: LoadedDiff }
  | { kind: 'failed' };

/** A resolved async diff outcome (loaded/failed) tagged with the request key
 *  (rootId:path:staged:untracked) it belongs to, so a stale resolution for a
 *  previously-selected file — OR a previously-active ROOT — is never shown for
 *  the current selection. The rootId is part of the key because the selection
 *  persists across a focus-root switch and two roots can share a relative path,
 *  so without it the old root's diff would render for the new root mid-load. */
interface ResolvedDiff {
  readonly key: string;
  readonly state: Extract<DiffState, { kind: 'loaded' | 'failed' }>;
}

/** Split the flat status file list into the three reviewer-facing buckets. */
function partitionFiles(files: readonly GitStatusFile[]): {
  staged: GitStatusFile[];
  unstaged: GitStatusFile[];
  untracked: GitStatusFile[];
} {
  const staged: GitStatusFile[] = [];
  const unstaged: GitStatusFile[] = [];
  const untracked: GitStatusFile[] = [];
  for (const file of files) {
    if (file.untracked) {
      untracked.push(file);
    } else {
      if (file.staged) {
        staged.push(file);
      }
      if (file.unstaged) {
        unstaged.push(file);
      }
    }
  }
  return { staged, unstaged, untracked };
}

function FileRow({
  file,
  isSelected,
  onSelect,
  action,
}: {
  readonly file: GitStatusFile;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  readonly action: ReactElement;
}): ReactElement {
  return (
    <li className="flex items-center gap-1">
      <button
        aria-current={isSelected ? 'true' : undefined}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent ${
          isSelected ? 'bg-accent' : ''
        }`}
        onClick={onSelect}
        type="button"
      >
        <span
          aria-hidden="true"
          className="w-3 shrink-0 text-center font-mono text-muted-foreground text-xs"
        >
          {file.status}
        </span>
        <span className="truncate" title={file.path}>
          {file.path}
        </span>
      </button>
      {action}
    </li>
  );
}

function FileSection({
  title,
  files,
  emptyHidden,
  selected,
  onSelect,
  renderAction,
}: {
  readonly title: string;
  readonly files: readonly GitStatusFile[];
  readonly emptyHidden: boolean;
  readonly selected: SelectedFile | null;
  readonly onSelect: (file: GitStatusFile, staged: boolean) => void;
  readonly renderAction: (file: GitStatusFile) => ReactElement;
}): ReactElement | null {
  if (files.length === 0 && emptyHidden) {
    return null;
  }
  const isStagedSection = title === 'Staged';
  return (
    <section className="mb-3">
      <h3 className="px-2 py-1 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
        {title} ({files.length})
      </h3>
      <ul>
        {files.map((file) => (
          <FileRow
            action={renderAction(file)}
            file={file}
            isSelected={selected?.path === file.path && selected?.staged === isStagedSection}
            key={`${title}:${file.path}`}
            onSelect={() => onSelect(file, isStagedSection)}
          />
        ))}
      </ul>
    </section>
  );
}

function SyncControls({
  ahead,
  behind,
  isSyncing,
  onPull,
  onPush,
  remotes,
  scope,
  status,
}: {
  readonly ahead: number;
  readonly behind: number;
  readonly isSyncing: boolean;
  readonly onPull: () => void;
  readonly onPush: (remote?: string) => void;
  readonly remotes: readonly string[];
  readonly scope: 'repository' | 'workspace';
  readonly status: NonNullable<ReturnType<typeof useGitPanel>['status']>;
}): ReactElement {
  const fullWorktree = scope === 'repository';
  return (
    <div className="flex items-center gap-2 border-border border-b px-3 py-2">
      <Button
        aria-label="Pull from upstream"
        disabled={isSyncing || !status.upstream || !fullWorktree}
        onClick={onPull}
        size="sm"
        type="button"
        variant="outline"
      >
        <Download aria-hidden="true" className="mr-1" />
        Pull
        {behind > 0 ? (
          <Badge className="ml-1" data-testid="behind-badge" variant="secondary">
            <ArrowDown aria-hidden="true" className="mr-0.5" />
            {behind}
          </Badge>
        ) : null}
      </Button>
      {status.upstream ? (
        <Button
          aria-label="Push to upstream"
          disabled={isSyncing || !status.branch || !fullWorktree}
          onClick={() => onPush()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Upload aria-hidden="true" className="mr-1" />
          Push
          {ahead > 0 ? (
            <Badge className="ml-1" data-testid="ahead-badge" variant="secondary">
              <ArrowUp aria-hidden="true" className="mr-0.5" />
              {ahead}
            </Badge>
          ) : null}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Choose remote to publish branch"
              disabled={isSyncing || !status.branch || !fullWorktree || remotes.length === 0}
              size="sm"
              type="button"
              variant="outline"
            >
              <Upload aria-hidden="true" className="mr-1" />
              Publish
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {remotes.map((remote) => (
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

/** Centered muted message used by several DiffPane states. */
function DiffPaneMessage({
  children,
  testId,
  tone,
}: {
  readonly children: ReactElement | string;
  readonly testId?: string;
  readonly tone?: 'muted' | 'destructive';
}): ReactElement {
  return (
    <div
      className={`flex h-full items-center justify-center px-6 text-center text-sm ${
        tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
      }`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * Right pane: the diff for the selected file. Renders distinct states for
 * no-selection / loading / load-FAILURE / actual diff / no-textual-changes, so
 * the pane never conflates a bridge error or an empty diff into one misleading
 * message. Extracted so {@link GitPanel} stays within the cognitive-complexity
 * budget.
 */
function DiffPane({
  selected,
  diffState,
  parsedDiff,
}: {
  readonly selected: SelectedFile | null;
  readonly diffState: DiffState;
  readonly parsedDiff: ParsedUnifiedDiff | null;
}): ReactElement {
  if (!selected) {
    return <DiffPaneMessage>Select a file to view its diff.</DiffPaneMessage>;
  }
  if (diffState.kind === 'loading' || diffState.kind === 'idle') {
    return <DiffPaneMessage>Loading diff…</DiffPaneMessage>;
  }
  if (diffState.kind === 'failed') {
    return (
      <DiffPaneMessage testId="git-panel-diff-error" tone="destructive">
        {`Could not load the diff for ${selected.path}.`}
      </DiffPaneMessage>
    );
  }
  if (parsedDiff?.hasHunks) {
    return (
      <DiffView
        ariaLabel={`Diff for ${selected.path}`}
        filename={selected.path}
        key={`${selected.path}:${selected.staged}`}
        modified={parsedDiff.modified}
        original={parsedDiff.original}
        testId="git-panel-diff"
        truncated={diffState.diff.truncated}
      />
    );
  }
  // Loaded but no hunks: an empty (e.g. mode-only) change.
  return (
    <DiffPaneMessage testId="git-panel-no-textual-diff">
      {`No textual changes to display for ${selected.path}.`}
    </DiffPaneMessage>
  );
}

/**
 * Owns the selected-file → diff lifecycle: tracks the clicked file and loads its
 * diff via the bridge into a discriminated {@link DiffState}. Keeps {@link GitPanel}
 * within its cognitive-complexity budget and isolates the load effect.
 */
function useSelectedDiff(
  loadDiff: ReturnType<typeof useGitPanel>['loadDiff'],
  activeRootId: string | null
): {
  selected: SelectedFile | null;
  handleSelect: (file: GitStatusFile, staged: boolean) => void;
  diffState: DiffState;
  parsedDiff: ParsedUnifiedDiff | null;
} {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  // Track ONLY the resolved async outcome (loaded/failed), tagged with the
  // request key it belongs to. idle/loading are DERIVED during render from the
  // selection + this outcome, so the effect never mirrors a derived value back
  // into state with a synchronous setState (the React-recommended pattern: the
  // effect's only setState is the async `.then` "subscribe to external system"
  // callback). This still distinguishes a load FAILURE from a legitimately empty
  // diff so the pane never lies about why it is empty.
  const [resolved, setResolved] = useState<ResolvedDiff | null>(null);

  const handleSelect = useCallback((file: GitStatusFile, staged: boolean) => {
    setSelected({ path: file.path, staged, untracked: file.untracked });
  }, []);

  // Key the fetch on the selected file's IDENTITY (path + staged + untracked),
  // not the whole `status` object, so an unrelated status refresh (staging a
  // different file, push/pull, focus refetch) does not re-fetch + rebuild the
  // open diff. The selected file's own staged↔unstaged transition changes
  // `selected` and so still re-fetches correctly.
  const selectedPath = selected?.path ?? null;
  const selectedStaged = selected?.staged ?? false;
  const selectedUntracked = selected?.untracked ?? false;
  // The activeRootId is part of the key: the selection survives a focus-root
  // switch and two roots can share a relative path, so without it a stale diff
  // from the previous root would render for the new root's same-path selection.
  const requestKey =
    selectedPath === null
      ? null
      : `${activeRootId ?? ''}:${selectedPath}:${selectedStaged}:${selectedUntracked}`;

  useEffect(() => {
    if (selectedPath === null || requestKey === null) {
      return;
    }
    let cancelled = false;
    void loadDiff(selectedPath, { staged: selectedStaged, untracked: selectedUntracked }).then(
      (result) => {
        if (cancelled) {
          return;
        }
        // `loadDiff` returns null ONLY on a bridge error (already toasted).
        setResolved(
          result
            ? { key: requestKey, state: { diff: result, kind: 'loaded' } }
            : { key: requestKey, state: { kind: 'failed' } }
        );
      }
    );
    return () => {
      cancelled = true;
    };
  }, [requestKey, selectedPath, selectedStaged, selectedUntracked, loadDiff]);

  // Derive the pane state: no selection → idle; a resolved outcome for the
  // CURRENT request → that outcome; otherwise the fetch is still in flight.
  const diffState: DiffState =
    requestKey === null
      ? { kind: 'idle' }
      : resolved?.key === requestKey
        ? resolved.state
        : { kind: 'loading' };

  // The resolved diff that belongs to the CURRENT selection (null while loading,
  // on failure, or when `resolved` is stale for a previously-selected file).
  const currentDiff =
    resolved?.key === requestKey && resolved.state.kind === 'loaded' ? resolved.state.diff : null;
  // Memo keyed on the STABLE resolved diff (not the per-render `diffState` object)
  // so the parse only re-runs when the loaded diff itself changes.
  const parsedDiff = useMemo(
    () => (currentDiff ? parseUnifiedDiff(currentDiff.unifiedDiff) : null),
    [currentDiff]
  );

  return { diffState, handleSelect, parsedDiff, selected };
}

/**
 * Desktop Git review surface. Driven entirely by the `window.git` bridge (via
 * {@link useGitPanel}): shows the changed-file list for the active workspace
 * root grouped into staged / unstaged / untracked, per-file stage/unstage,
 * a commit box, push/pull with ahead/behind badges, and a {@link DiffView} for
 * the selected file. Every git failure surfaces as a toast + log inside the
 * hook — this component only renders state.
 *
 * This component is constructed only on desktop (the wrapper checks
 * `window.git`); it still renders its own non-repo / no-root empty states.
 */
export function GitPanel(): ReactElement {
  const {
    activeRootId,
    status,
    isLoading,
    statusError,
    isSyncing,
    refresh,
    stageFile,
    unstageFile,
    commit,
    push,
    pull,
    loadDiff,
    repository,
    repositoryError,
  } = useGitPanel();

  const [commitMessage, setCommitMessage] = useState('');
  const { selected, handleSelect, diffState, parsedDiff } = useSelectedDiff(loadDiff, activeRootId);

  const buckets = useMemo(() => partitionFiles(status?.files ?? []), [status?.files]);

  const handleCommit = useCallback(async () => {
    const ok = await commit(commitMessage);
    if (ok) {
      setCommitMessage('');
    }
  }, [commit, commitMessage]);

  if (!activeRootId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm"
        data-testid="git-panel-no-root"
      >
        Open a workspace folder to review and commit changes with Git.
      </div>
    );
  }

  if (statusError) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
        data-testid="git-panel-error"
      >
        <p className="text-destructive">Could not load Git status.</p>
        <p className="max-w-md text-muted-foreground text-xs">{statusError}</p>
        <Button onClick={refresh} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" className="mr-1" />
          Retry
        </Button>
      </div>
    );
  }

  if (status && !status.isRepository) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm"
        data-testid="git-panel-not-a-repo"
      >
        This folder is not a Git repository.
      </div>
    );
  }

  if (repositoryError) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
        data-testid="git-panel-error"
      >
        <p className="text-destructive">Could not load repository details.</p>
        <p className="max-w-md text-muted-foreground text-xs">{repositoryError}</p>
        <Button onClick={refresh} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" className="mr-1" />
          Retry
        </Button>
      </div>
    );
  }

  if (!(status && repository)) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground text-sm">
        Loading Git workbench…
      </div>
    );
  }

  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const hasChanges = status.files.length > 0;

  return (
    <div className="flex h-full min-h-0" data-testid="git-panel">
      {/* Left: branch header, file list, commit box, push/pull */}
      <div className="flex w-80 shrink-0 flex-col border-border border-r">
        <div className="flex items-center justify-between gap-2 border-border border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <GitBranch aria-hidden="true" className="shrink-0 text-muted-foreground" />
            <span className="truncate font-medium text-sm" title={status?.branch ?? undefined}>
              {status?.branch ?? 'detached HEAD'}
            </span>
          </div>
          <Button
            aria-label="Refresh Git status"
            disabled={isLoading}
            onClick={refresh}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" className={isLoading ? 'animate-spin' : undefined} />
          </Button>
        </div>

        <SyncControls
          ahead={ahead}
          behind={behind}
          isSyncing={isSyncing}
          onPull={() => void pull()}
          onPush={(remote) => void push(remote)}
          remotes={repository.remotes}
          scope={repository.scope}
          status={status}
        />

        <ScrollArea className="min-h-0 flex-1">
          <div className="py-2">
            {hasChanges ? (
              <>
                <FileSection
                  emptyHidden={true}
                  files={buckets.staged}
                  onSelect={handleSelect}
                  renderAction={(file) => (
                    <Button
                      aria-label={`Unstage ${file.path}`}
                      onClick={() => unstageFile(file.path)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <FileMinus aria-hidden="true" />
                    </Button>
                  )}
                  selected={selected}
                  title="Staged"
                />
                <FileSection
                  emptyHidden={true}
                  files={buckets.unstaged}
                  onSelect={handleSelect}
                  renderAction={(file) => (
                    <Button
                      aria-label={`Stage ${file.path}`}
                      onClick={() => stageFile(file.path)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <FilePlus aria-hidden="true" />
                    </Button>
                  )}
                  selected={selected}
                  title="Unstaged"
                />
                <FileSection
                  emptyHidden={true}
                  files={buckets.untracked}
                  onSelect={handleSelect}
                  renderAction={(file) => (
                    <Button
                      aria-label={`Stage ${file.path}`}
                      onClick={() => stageFile(file.path)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <FilePlus aria-hidden="true" />
                    </Button>
                  )}
                  selected={selected}
                  title="Untracked"
                />
              </>
            ) : (
              <p
                className="px-3 py-6 text-center text-muted-foreground text-sm"
                data-testid="git-panel-clean"
              >
                No changes. Working tree clean.
              </p>
            )}
          </div>
        </ScrollArea>

        {/* Commit box */}
        <div className="border-border border-t p-2">
          <label className="sr-only" htmlFor="git-commit-message">
            Commit message
          </label>
          <textarea
            className="min-h-16 w-full resize-none rounded-md border border-input bg-background p-2 text-sm outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
            id="git-commit-message"
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder="Commit message"
            value={commitMessage}
          />
          <Button
            className="mt-2 w-full"
            disabled={commitMessage.trim().length === 0 || buckets.staged.length === 0}
            onClick={handleCommit}
            size="sm"
            type="button"
          >
            Commit {buckets.staged.length > 0 ? `(${buckets.staged.length})` : ''}
          </Button>
        </div>
      </div>

      {/* Right: diff viewer */}
      <div className="min-w-0 flex-1">
        <DiffPane diffState={diffState} parsedDiff={parsedDiff} selected={selected} />
      </div>
    </div>
  );
}
