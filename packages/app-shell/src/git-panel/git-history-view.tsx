import { Badge, Button, ScrollArea } from '@brainstrike/ui';
import { GitCommitHorizontal, GitMerge, LoaderCircle } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import type { GitCommitFile, GitHistoryCommit } from './git-bridge';
import { GitDiffSurface, type GitDiffSurfaceState } from './git-diff-surface';
import type { LoadedDiff, UseGitPanelResult } from './use-git-panel';

interface HistoricalSelection {
  readonly commit: GitHistoryCommit;
  readonly file: GitCommitFile | null;
}

interface LoadedHistoricalDiff {
  readonly commitId: string;
  readonly diff: LoadedDiff | null;
  readonly path: string;
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

function resolveHistoricalDiffState(
  selection: HistoricalSelection | null,
  resolvedDiff: LoadedHistoricalDiff | null
): GitDiffSurfaceState {
  if (!selection?.file) {
    return {
      kind: 'empty',
      message: selection
        ? 'Select a file from this commit to inspect its diff.'
        : 'Select a commit to inspect its changes.',
    };
  }
  if (resolvedDiff?.commitId !== selection.commit.id || resolvedDiff.path !== selection.file.path) {
    return { kind: 'loading', message: `Loading ${selection.file.path}…` };
  }
  if (!resolvedDiff.diff) {
    return {
      kind: 'error',
      message: `Could not load the historical diff for ${selection.file.path}.`,
    };
  }
  return { diff: resolvedDiff.diff, kind: 'loaded', path: selection.file.path };
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

function GitHistoryBrowser({ panel }: { readonly panel: UseGitPanelResult }): ReactElement {
  const [historyList, setHistoryList] = useState<HistoryListState>(INITIAL_HISTORY_LIST_STATE);
  const [selection, setSelection] = useState<HistoricalSelection | null>(null);
  const [files, setFiles] = useState<readonly GitCommitFile[] | null>(null);
  const [filesError, setFilesError] = useState(false);
  const [resolvedDiff, setResolvedDiff] = useState<LoadedHistoricalDiff | null>(null);
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

  useEffect(() => {
    const commitId = selection?.commit.id;
    const file = selection?.file;
    if (!(commitId && file)) {
      return;
    }
    let cancelled = false;
    void panel.loadCommitDiff(commitId, file.path, file.originalPath).then((diff) => {
      if (!cancelled) {
        setResolvedDiff({ commitId, diff, path: file.path });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [panel.loadCommitDiff, selection?.commit.id, selection?.file]);

  const selectCommit = (commit: GitHistoryCommit): void => {
    setSelection({ commit, file: null });
    setFiles(null);
    setFilesError(false);
    setResolvedDiff(null);
  };

  const selectFile = (file: GitCommitFile): void => {
    if (!selection) {
      return;
    }
    setSelection({ commit: selection.commit, file });
    setResolvedDiff(null);
  };

  const retryFiles = (): void => {
    if (!selection) {
      return;
    }
    setFiles(null);
    setFilesError(false);
    void requestFiles(selection.commit.id);
  };

  const diffState = resolveHistoricalDiffState(selection, resolvedDiff);

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
          <div className="min-w-0 flex-1">
            <GitDiffSurface state={diffState} />
          </div>
        </div>
      </section>
    </div>
  );
}

export function GitHistoryView({ panel }: { readonly panel: UseGitPanelResult }): ReactElement {
  return <GitHistoryBrowser key={panel.activeRootId ?? 'no-active-root'} panel={panel} />;
}
