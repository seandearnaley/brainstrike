/**
 * DIFF-SOURCING DESIGN (BST-1116 W6 Task B): the History tab's commit diff no
 * longer reconstructs a unified-diff string via `parseUnifiedDiff` (through
 * `git-diff-surface.tsx`, deleted by this task, which used
 * `useGitPanel.loadCommitDiff` — also removed). It resolves through the
 * structured diff engine's `commit` mode directly
 * (`StructuredFileDiffParams`, `packages/types/src/changeset.ts`:
 * `{ commitId, mode: 'commit', path }`, diffing `<commitId>^` vs
 * `<commitId>` for one path) via `useGitPanel.loadCommitFileDiff`, and
 * renders the result with the shared `ChangesetFileDiffCard`
 * (`../changes/ui/changeset-file-diff-card`) — the same leaf component Task
 * A's Changes tab renders through.
 *
 * WHY NOT `useChangeset`/`window.changes` (the route Task A's Changes tab
 * takes): that route exists because the Changes tab's diff must be scoped to
 * whichever `staged`/`unstaged`/`uncommitted` `GitScope` the selected row
 * belongs to, and only the changeset engine's `window.changes` bridge
 * resolves a `GitScope`. The History tab's need is narrower — exactly one
 * commit, one path — and `StructuredFileDiffParams`'s `commit` mode is
 * already exposed directly on `window.git` (the SAME bridge `commitFiles`/
 * `history` below already use), so this view calls straight through
 * `useGitPanel` instead of adding a second bridge dependency for no
 * behavioral gain.
 *
 * WHAT STAYED PANEL-OWNED: the `bridge.commitFiles`-driven commit file
 * listing (`CommitFilesSidebar`) is completely unchanged — still a flat
 * `GitCommitFile[]` list with its own request-generation staleness guard
 * (`filesRequestRef`). `parseUnifiedDiff` never touched that listing; only
 * the diff PANE moved.
 *
 * RENAME PARITY (verified, not assumed — BST-1116 W6 Task B): the old path
 * used to ride the retired `commitDiff` op's explicit `originalPath`
 * pathspec. `StructuredFileDiffParams`'s `commit` mode has no such field —
 * only `path`. Reading `git-structured-diff.ts`'s `structuredRefDiff`
 * (shared, unmodified, between `commit` and `range` mode) confirms the
 * engine detects the rename itself: `resolveRefEntryForPath` runs its
 * `--find-renames` numstat UNRESTRICTED by pathspec (`-- .`, the whole
 * worktree — see `runNumstat`'s doc comment), so it can pair the new path
 * back to its old one even though only the new path was requested; the
 * resulting `entry.oldPath` is then threaded into BOTH the old-side blob
 * read and the unified-diff pathspecs (`readDiffSides`/`computeUnifiedDiff`
 * calls, lines ~945-957), matching the module's own documented requirement
 * that a rename's old AND new paths must both be passed as pathspecs
 * together (doc comment, lines ~297-311) or pairing silently fails. The unit
 * test `apps/desktop/src/__tests__/assistant-server/git-service-structured-diff.test.ts`
 * ("routes the old-side read through oldPath, not the current path") proves
 * this exact mechanism end-to-end for `staged` mode, which shares the
 * identical `runNumstat`/`readDiffSides`/`computeUnifiedDiff` machinery with
 * `commit` mode via `structuredRefDiff` — no separate `commit`-mode rename
 * codepath exists to diverge. No new engine test was added per this task's
 * scope; this is a read-and-confirm, not a new claim.
 *
 * STALENESS: `ChangesetFileDiffCard` is mounted with `key={commitId:path}` —
 * selecting a different commit or file remounts a fresh card instance with
 * its own generation counter (see that module's doc comment), so a slow
 * response for a PRIOR selection can never clobber the newer card: the old
 * instance is gone, and React drops a `setState` call against an unmounted
 * component rather than committing it. This replaces the `cancelled`-flag
 * guard the old `useEffect`-based load used for the same property.
 */
import type {
  ChangedFileEntry,
  ChangedFileStatus,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import { Badge, Button, ScrollArea, useToast } from '@brainstrike/ui';
import { GitCommitHorizontal, GitMerge, LoaderCircle } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ChangesetFileDiffCard } from '../changes/ui/changeset-file-diff-card';
import { summarizeGitFailure } from '../git-failure-summary';
import type { GitCommitFile, GitHistoryCommit, GitRepository } from './git-bridge';
import type { UseGitPanelResult } from './use-git-panel';

interface HistoricalSelection {
  readonly commit: GitHistoryCommit;
  readonly file: GitCommitFile | null;
}

interface HistoryListState {
  readonly commits: readonly GitHistoryCommit[] | null;
  readonly hasError: boolean;
  readonly isLoadingMore: boolean;
  readonly nextOffset: number | null;
}

const INITIAL_HISTORY_LIST_STATE: HistoryListState = {
  commits: null,
  hasError: false,
  isLoadingMore: false,
  nextOffset: null,
};

const COMMIT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatCommitDate(value: string): string {
  return COMMIT_DATE_FORMATTER.format(new Date(value));
}

/** `GitCommitFile.status` is git's raw porcelain-v2 letter (untyped —
 * `packages/types/src/git.ts`); this is a display-only best-effort mapping
 * onto the shared engine's closed `ChangedFileStatus` union for
 * `ChangesetFileDiffCard`'s header label. It never gates behavior. Mirrors
 * `git-changes-view.tsx`'s `statusLetterToChangedFileStatus` (Task A's
 * precedent for this exact kind of mapping) — not shared/imported because
 * the two source types (`GitStatusFile`, `GitCommitFile`) are structurally
 * distinct despite the overlapping `status` letter convention. */
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

function HistorySidebar({
  historyList,
  loadOlderCommits,
  retryInitialHistory,
  selectCommit,
  selectedCommitId,
}: {
  readonly historyList: HistoryListState;
  readonly loadOlderCommits: () => Promise<void>;
  readonly retryInitialHistory: () => void;
  readonly selectCommit: (commit: GitHistoryCommit) => void;
  readonly selectedCommitId: string | undefined;
}): ReactElement {
  const { commits, hasError, isLoadingMore, nextOffset } = historyList;

  if (commits === null) {
    return (
      <aside className="w-[36%] min-w-80 max-w-[42rem] shrink-0 border-border border-r bg-card/15">
        <div className="flex items-center justify-center gap-2 px-6 py-10 text-muted-foreground text-sm">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading history…
        </div>
      </aside>
    );
  }

  if (hasError) {
    return (
      <aside className="w-[36%] min-w-80 max-w-[42rem] shrink-0 border-border border-r bg-card/15">
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm">
          <p className="text-destructive">Could not load commit history.</p>
          <Button onClick={retryInitialHistory} size="sm" variant="outline">
            Retry history
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[36%] min-w-80 max-w-[42rem] shrink-0 border-border border-r bg-card/15">
      <ScrollArea className="h-full">
        {commits.length === 0 ? (
          <p className="px-6 py-10 text-center text-muted-foreground text-sm">No commits found.</p>
        ) : (
          <ul>
            {commits.map((commit) => (
              <li className="border-border border-b" key={commit.id}>
                <button
                  aria-current={selectedCommitId === commit.id ? 'true' : undefined}
                  className={`flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/45 ${
                    selectedCommitId === commit.id ? 'bg-primary/12' : ''
                  }`}
                  onClick={() => selectCommit(commit)}
                  type="button"
                >
                  {commit.parentIds.length > 1 ? (
                    <GitMerge
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 text-primary"
                    />
                  ) : (
                    <GitCommitHorizontal
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-xs">{commit.summary}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="truncate">{commit.authorName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">{formatCommitDate(commit.committedAt)}</span>
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {commit.shortId}
                  </span>
                </button>
              </li>
            ))}
            {nextOffset === null ? null : (
              <li className="p-2">
                <Button
                  className="w-full"
                  disabled={isLoadingMore}
                  onClick={() => void loadOlderCommits()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {isLoadingMore ? (
                    <>
                      <LoaderCircle aria-hidden="true" className="animate-spin" />
                      Loading older commits…
                    </>
                  ) : (
                    'Load older commits'
                  )}
                </Button>
              </li>
            )}
          </ul>
        )}
      </ScrollArea>
    </aside>
  );
}

function CommitFilesSidebar({
  files,
  filesError,
  retryFiles,
  selectFile,
  selection,
}: {
  readonly files: readonly GitCommitFile[] | null;
  readonly filesError: boolean;
  readonly retryFiles: () => void;
  readonly selectFile: (file: GitCommitFile) => void;
  readonly selection: HistoricalSelection;
}): ReactElement {
  return (
    <aside className="w-64 shrink-0 border-border border-r bg-card/15">
      <div className="flex h-9 items-center border-border border-b px-3 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        {filesError
          ? 'Files unavailable'
          : files === null
            ? 'Loading files…'
            : `${files.length} changed ${files.length === 1 ? 'file' : 'files'}`}
      </div>
      <ScrollArea className="h-[calc(100%-2.25rem)]">
        {filesError ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-xs">
            <p className="text-destructive">Could not load files for this commit.</p>
            <Button onClick={retryFiles} size="sm" variant="outline">
              Retry commit files
            </Button>
          </div>
        ) : (
          <ul>
            {(files ?? []).map((file) => (
              <li className="border-border border-b" key={`${file.status}:${file.path}`}>
                <Button
                  aria-current={selection.file?.path === file.path ? 'true' : undefined}
                  className={`h-auto w-full justify-start rounded-none px-3 py-2 font-normal text-xs ${
                    selection.file?.path === file.path ? 'bg-primary/12' : ''
                  }`}
                  onClick={() => selectFile(file)}
                  type="button"
                  variant="ghost"
                >
                  <span
                    aria-hidden="true"
                    className="w-4 shrink-0 font-mono font-semibold text-[10px] text-muted-foreground"
                  >
                    {file.status}
                  </span>
                  <span className="truncate">{file.path}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </aside>
  );
}

function HistoricalDiffPane({
  loadCommitFileDiff,
  repository,
  rootId,
  selection,
}: {
  readonly loadCommitFileDiff: UseGitPanelResult['loadCommitFileDiff'];
  readonly repository: GitRepository;
  readonly rootId: string | null;
  readonly selection: HistoricalSelection | null;
}): ReactElement {
  const { toast } = useToast();

  // Rebuilt whenever the selected commit/file changes — the card below is
  // remounted (`key`) at the same cadence, so this closure's `commitId` is
  // never stale for the instance that calls it. See this module's doc
  // comment (STALENESS).
  const loadFileDiff = useCallback(
    async (path: string): Promise<GitResult<StructuredFileDiff>> => {
      const commitId = selection?.commit.id;
      if (!commitId) {
        return { error: 'no commit selected', ok: false };
      }
      const result = await loadCommitFileDiff(commitId, path);
      if (!result.ok) {
        toast({
          description: summarizeGitFailure(result.error),
          title: 'Commit diff failed',
          variant: 'destructive',
        });
      }
      return result;
    },
    [loadCommitFileDiff, selection?.commit.id, toast]
  );

  if (!selection?.file) {
    return (
      <div className="grid h-full min-h-0 place-items-center px-8 text-center text-muted-foreground text-sm">
        <div className="max-w-sm leading-relaxed">
          {selection
            ? 'Select a file from this commit to inspect its diff.'
            : 'Select a commit to inspect its changes.'}
        </div>
      </div>
    );
  }

  const { file } = selection;
  const entry: ChangedFileEntry = {
    additions: null,
    deletions: null,
    ...(file.originalPath ? { oldPath: file.originalPath } : {}),
    path: file.path,
    repositoryRoot: repository.repositoryRoot,
    revertible: false,
    rootId,
    status: statusLetterToChangedFileStatus(file.status),
    // The OPENED root, not `currentWorktree.path` — `bridge.commitFiles`
    // returns paths already scoped to the opened folder, and
    // `ChangedFileEntry.path` is contractually "relative to the owning
    // worktree root". Identical outside `repository.scope === 'workspace'`.
    // (Display-only here: `loadCommitFileDiff` resolves its cwd from
    // `rootId` on the `git` domain, never from this field.)
    worktreePath: repository.openedRoot,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChangesetFileDiffCard
        bodyClassName="min-h-0 flex-1"
        changesetKind="git-scope"
        className="flex min-h-0 flex-1 flex-col"
        entry={entry}
        key={`${selection.commit.id}:${file.path}`}
        loadFileDiff={loadFileDiff}
      />
    </div>
  );
}

function GitHistoryBrowser({
  panel,
  repository,
}: {
  readonly panel: UseGitPanelResult;
  readonly repository: GitRepository;
}): ReactElement {
  const [historyList, setHistoryList] = useState<HistoryListState>(INITIAL_HISTORY_LIST_STATE);
  const [selection, setSelection] = useState<HistoricalSelection | null>(null);
  const [files, setFiles] = useState<readonly GitCommitFile[] | null>(null);
  const [filesError, setFilesError] = useState(false);
  const filesRequestRef = useRef(0);
  const historyGenerationRef = useRef(0);
  const { isLoadingMore, nextOffset } = historyList;

  const requestInitialHistory = useCallback(async (): Promise<void> => {
    const generation = historyGenerationRef.current + 1;
    historyGenerationRef.current = generation;
    const page = await panel.loadHistory();
    if (historyGenerationRef.current !== generation) {
      return;
    }
    if (!page) {
      setHistoryList({ commits: [], hasError: true, isLoadingMore: false, nextOffset: null });
      return;
    }
    setHistoryList({
      commits: page.commits,
      hasError: false,
      isLoadingMore: false,
      nextOffset: page.hasMore ? page.offset + page.limit : null,
    });
  }, [panel.loadHistory]);

  useEffect(() => {
    const generation = historyGenerationRef.current + 1;
    historyGenerationRef.current = generation;
    void panel.loadHistory().then((page) => {
      if (historyGenerationRef.current !== generation) {
        return;
      }
      if (!page) {
        setHistoryList({ commits: [], hasError: true, isLoadingMore: false, nextOffset: null });
        return;
      }
      setHistoryList({
        commits: page.commits,
        hasError: false,
        isLoadingMore: false,
        nextOffset: page.hasMore ? page.offset + page.limit : null,
      });
    });
    return () => {
      historyGenerationRef.current += 1;
    };
  }, [panel.loadHistory]);

  const retryInitialHistory = (): void => {
    setHistoryList(INITIAL_HISTORY_LIST_STATE);
    void requestInitialHistory();
  };

  const loadOlderCommits = useCallback(async (): Promise<void> => {
    if (nextOffset === null || isLoadingMore) {
      return;
    }
    const generation = historyGenerationRef.current;
    setHistoryList((current) => ({ ...current, isLoadingMore: true }));
    const page = await panel.loadHistory({ offset: nextOffset });
    if (historyGenerationRef.current !== generation) {
      return;
    }
    if (!page) {
      setHistoryList((current) => ({ ...current, isLoadingMore: false }));
      return;
    }
    setHistoryList((current) => {
      const combined = [...(current.commits ?? [])];
      const seen = new Set(combined.map((commit) => commit.id));
      for (const commit of page.commits) {
        if (!seen.has(commit.id)) {
          combined.push(commit);
          seen.add(commit.id);
        }
      }
      return {
        commits: combined,
        hasError: false,
        isLoadingMore: false,
        nextOffset: page.hasMore ? page.offset + page.limit : null,
      };
    });
  }, [isLoadingMore, nextOffset, panel.loadHistory]);

  const requestFiles = useCallback(
    async (commitId: string): Promise<void> => {
      const request = filesRequestRef.current + 1;
      filesRequestRef.current = request;
      const result = await panel.loadCommitFiles(commitId);
      if (filesRequestRef.current !== request) {
        return;
      }
      if (!result) {
        setFilesError(true);
        return;
      }
      setFiles(result);
    },
    [panel.loadCommitFiles]
  );

  useEffect(() => {
    const commitId = selection?.commit.id;
    if (!commitId) {
      return;
    }
    const request = filesRequestRef.current + 1;
    filesRequestRef.current = request;
    void panel.loadCommitFiles(commitId).then((result) => {
      if (filesRequestRef.current !== request) {
        return;
      }
      if (!result) {
        setFilesError(true);
        return;
      }
      setFiles(result);
    });
    return () => {
      filesRequestRef.current += 1;
    };
  }, [panel.loadCommitFiles, selection?.commit.id]);

  const selectCommit = (commit: GitHistoryCommit): void => {
    setSelection({ commit, file: null });
    setFiles(null);
    setFilesError(false);
  };

  const selectFile = (file: GitCommitFile): void => {
    if (!selection) {
      return;
    }
    setSelection({ commit: selection.commit, file });
  };

  const retryFiles = (): void => {
    if (!selection) {
      return;
    }
    setFiles(null);
    setFilesError(false);
    void requestFiles(selection.commit.id);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <HistorySidebar
        historyList={historyList}
        loadOlderCommits={loadOlderCommits}
        retryInitialHistory={retryInitialHistory}
        selectCommit={selectCommit}
        selectedCommitId={selection?.commit.id}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        {selection ? (
          <div className="shrink-0 border-border border-b bg-muted/20 px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-sm">{selection.commit.summary}</h2>
                {selection.commit.body ? (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed">
                    {selection.commit.body}
                  </p>
                ) : null}
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {selection.commit.authorName} &lt;{selection.commit.authorEmail}&gt; ·{' '}
                  {formatCommitDate(selection.commit.committedAt)}
                </p>
              </div>
              <Badge className="font-mono" variant="outline">
                {selection.commit.shortId}
              </Badge>
            </div>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {selection ? (
            <CommitFilesSidebar
              files={files}
              filesError={filesError}
              retryFiles={retryFiles}
              selectFile={selectFile}
              selection={selection}
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <HistoricalDiffPane
              loadCommitFileDiff={panel.loadCommitFileDiff}
              repository={repository}
              rootId={panel.activeRootId}
              selection={selection}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

export function GitHistoryView({
  panel,
  repository,
}: {
  readonly panel: UseGitPanelResult;
  readonly repository: GitRepository;
}): ReactElement {
  return (
    <GitHistoryBrowser
      key={panel.activeRootId ?? 'no-active-root'}
      panel={panel}
      repository={repository}
    />
  );
}
