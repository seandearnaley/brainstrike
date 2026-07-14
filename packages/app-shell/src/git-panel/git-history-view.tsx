import { Badge, Button, ScrollArea } from '@brainstrike/ui';
import { GitCommitHorizontal, GitMerge, LoaderCircle } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
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

function formatCommitDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
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

export function GitHistoryView({ panel }: { readonly panel: UseGitPanelResult }): ReactElement {
  const [commits, setCommits] = useState<readonly GitHistoryCommit[] | null>(null);
  const [selection, setSelection] = useState<HistoricalSelection | null>(null);
  const [files, setFiles] = useState<readonly GitCommitFile[] | null>(null);
  const [resolvedDiff, setResolvedDiff] = useState<LoadedHistoricalDiff | null>(null);

  useEffect(() => {
    let cancelled = false;
    void panel.loadHistory().then((page) => {
      if (!cancelled) {
        setCommits(page?.commits ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [panel.activeRootId, panel.loadHistory]);

  useEffect(() => {
    const commitId = selection?.commit.id;
    if (!commitId) {
      return;
    }
    let cancelled = false;
    void panel.loadCommitFiles(commitId).then((result) => {
      if (!cancelled) {
        setFiles(result ?? []);
      }
    });
    return () => {
      cancelled = true;
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
    setResolvedDiff(null);
  };

  const selectFile = (file: GitCommitFile): void => {
    if (!selection) {
      return;
    }
    setSelection({ commit: selection.commit, file });
    setResolvedDiff(null);
  };

  const diffState = resolveHistoricalDiffState(selection, resolvedDiff);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-[36%] min-w-80 max-w-[42rem] shrink-0 border-border border-r bg-card/15">
        <ScrollArea className="h-full">
          {commits === null ? (
            <div className="flex items-center justify-center gap-2 px-6 py-10 text-muted-foreground text-sm">
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              Loading history…
            </div>
          ) : commits.length === 0 ? (
            <p className="px-6 py-10 text-center text-muted-foreground text-sm">
              No commits found.
            </p>
          ) : (
            <ul>
              {commits.map((commit) => (
                <li className="border-border border-b" key={commit.id}>
                  <button
                    aria-current={selection?.commit.id === commit.id ? 'true' : undefined}
                    className={`flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/45 ${
                      selection?.commit.id === commit.id ? 'bg-primary/12' : ''
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
            </ul>
          )}
        </ScrollArea>
      </aside>

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
            <aside className="w-64 shrink-0 border-border border-r bg-card/15">
              <div className="flex h-9 items-center border-border border-b px-3 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                {files === null
                  ? 'Loading files…'
                  : `${files.length} changed ${files.length === 1 ? 'file' : 'files'}`}
              </div>
              <ScrollArea className="h-[calc(100%-2.25rem)]">
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
              </ScrollArea>
            </aside>
          ) : null}
          <div className="min-w-0 flex-1">
            <GitDiffSurface state={diffState} />
          </div>
        </div>
      </section>
    </div>
  );
}
