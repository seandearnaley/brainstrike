import {
  Badge,
  Button,
  DiffView,
  type ParsedUnifiedDiff,
  parseUnifiedDiff,
  ScrollArea,
} from '@brainstrike/ui';
import {
  ArrowDown,
  ArrowUp,
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

/**
 * Right pane: the diff for the selected file (or a placeholder / loading /
 * no-textual-change state). Extracted so {@link GitPanel} stays within the
 * cognitive-complexity budget.
 */
function DiffPane({
  selected,
  isDiffLoading,
  parsedDiff,
  diff,
}: {
  readonly selected: SelectedFile | null;
  readonly isDiffLoading: boolean;
  readonly parsedDiff: ParsedUnifiedDiff | null;
  readonly diff: LoadedDiff | null;
}): ReactElement {
  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Select a file to view its diff.
      </div>
    );
  }
  if (isDiffLoading && !parsedDiff) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading diff…
      </div>
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
        truncated={diff?.truncated ?? false}
      />
    );
  }
  return (
    <div
      className="flex h-full items-center justify-center text-muted-foreground text-sm"
      data-testid="git-panel-no-textual-diff"
    >
      No textual changes to display for {selected.path}.
    </div>
  );
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
  } = useGitPanel();

  const [commitMessage, setCommitMessage] = useState('');
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [diff, setDiff] = useState<LoadedDiff | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);

  const buckets = useMemo(() => partitionFiles(status?.files ?? []), [status?.files]);

  const handleSelect = useCallback((file: GitStatusFile, staged: boolean) => {
    setSelected({ path: file.path, staged });
  }, []);

  // Load (or reload) the diff whenever the selection changes or status refreshes.
  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setIsDiffLoading(true);
    void loadDiff(selected.path, selected.staged)
      .then((result) => {
        if (!cancelled) {
          setDiff(result);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsDiffLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, loadDiff, status]);

  const parsedDiff = useMemo(() => (diff ? parseUnifiedDiff(diff.unifiedDiff) : null), [diff]);

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

  const ahead = status?.ahead ?? null;
  const behind = status?.behind ?? null;
  const hasChanges = (status?.files.length ?? 0) > 0;

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

        {/* Push/pull + ahead/behind */}
        <div className="flex items-center gap-2 border-border border-b px-3 py-2">
          <Button
            aria-label="Pull from upstream"
            disabled={isSyncing || !status?.upstream}
            onClick={pull}
            size="sm"
            type="button"
            variant="outline"
          >
            <Download aria-hidden="true" className="mr-1" />
            Pull
            {behind && behind > 0 ? (
              <Badge className="ml-1" data-testid="behind-badge" variant="secondary">
                <ArrowDown aria-hidden="true" className="mr-0.5" />
                {behind}
              </Badge>
            ) : null}
          </Button>
          <Button
            aria-label="Push to upstream"
            disabled={isSyncing || !status?.upstream}
            onClick={push}
            size="sm"
            type="button"
            variant="outline"
          >
            <Upload aria-hidden="true" className="mr-1" />
            Push
            {ahead && ahead > 0 ? (
              <Badge className="ml-1" data-testid="ahead-badge" variant="secondary">
                <ArrowUp aria-hidden="true" className="mr-0.5" />
                {ahead}
              </Badge>
            ) : null}
          </Button>
        </div>

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
        <DiffPane
          diff={diff}
          isDiffLoading={isDiffLoading}
          parsedDiff={parsedDiff}
          selected={selected}
        />
      </div>
    </div>
  );
}
