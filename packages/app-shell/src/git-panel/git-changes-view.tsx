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
import {
  type ReactElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { GitRepository, GitStatus, GitStatusFile } from './git-bridge';
import { GitDiffSurface, type GitDiffSurfaceState } from './git-diff-surface';
import type { LoadedDiff, UseGitPanelResult } from './use-git-panel';

interface SelectedFile {
  readonly path: string;
  readonly staged: boolean;
  readonly untracked: boolean;
}

interface ResolvedDiff {
  readonly key: string;
  readonly result: LoadedDiff | null;
}

function resolveDiffState(
  selected: SelectedFile | null,
  diffKey: string | null,
  resolvedDiff: ResolvedDiff | null
): GitDiffSurfaceState {
  if (!(selected && diffKey)) {
    return { kind: 'empty', message: 'Select a changed file to inspect its diff.' };
  }
  if (resolvedDiff?.key !== diffKey) {
    return { kind: 'loading', message: `Loading ${selected.path}…` };
  }
  if (!resolvedDiff.result) {
    return { kind: 'error', message: `Could not load the diff for ${selected.path}.` };
  }
  return { diff: resolvedDiff.result, kind: 'loaded', path: selected.path };
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
  return (
    <li className="group flex min-h-9 items-center border-border/70 border-b last:border-b-0">
      <button
        aria-current={selected ? 'true' : undefined}
        className={`flex min-w-0 flex-1 items-center gap-2 self-stretch px-3 text-left text-xs transition-colors hover:bg-accent/45 ${
          selected ? 'bg-primary/12 text-foreground' : 'text-foreground/90'
        }`}
        onClick={onSelect}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`w-4 shrink-0 text-center font-mono font-semibold text-[10px] ${
            file.status === '?' || file.status === 'A'
              ? 'text-emerald-500'
              : file.status === 'D'
                ? 'text-red-500'
                : 'text-amber-500'
          }`}
        >
          {file.status}
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
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter.trim().toLocaleLowerCase());
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [resolvedDiff, setResolvedDiff] = useState<ResolvedDiff | null>(null);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');

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
  const selectedPath = selected?.path ?? null;
  const selectedStaged = selected?.staged ?? false;
  const selectedUntracked = selected?.untracked ?? false;
  const diffKey = selectedPath
    ? `${panel.activeRootId ?? ''}:${selectedPath}:${selectedStaged}:${selectedUntracked}`
    : null;

  useEffect(() => {
    if (!(selectedPath && diffKey)) {
      return;
    }
    let cancelled = false;
    void panel
      .loadDiff(selectedPath, { staged: selectedStaged, untracked: selectedUntracked })
      .then((result) => {
        if (!cancelled) {
          setResolvedDiff({ key: diffKey, result });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [diffKey, panel.loadDiff, selectedPath, selectedStaged, selectedUntracked]);

  const selectFile = useCallback((file: GitStatusFile, staged: boolean) => {
    setSelected({ path: file.path, staged, untracked: file.untracked });
  }, []);

  const commitChanges = useCallback(async () => {
    const committed = await panel.commit(summary, description);
    if (committed) {
      setSummary('');
      setDescription('');
    }
  }, [description, panel.commit, summary]);

  const diffState = resolveDiffState(selected, diffKey, resolvedDiff);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[36%] min-w-80 max-w-[42rem] shrink-0 flex-col border-border border-r bg-card/15">
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
          <Input
            className="h-8 text-xs"
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
        <div className="min-h-0 flex-1">
          <GitDiffSurface state={diffState} />
        </div>
      </section>
    </div>
  );
}
