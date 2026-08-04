/**
 * `ChangedFilesTree`'s `TreeTable` column definitions and cell renderers
 * (BST-1114, W4 Task B), split out of `changed-files-tree.tsx` so that file
 * exports components only (`react-doctor/only-export-components`) — this
 * module exports the non-component `CHANGED_FILES_TREE_COLUMNS` array and
 * the `lastPathSegment` helper the main component also needs for its group
 * labels, and keeps every cell renderer file-local since nothing outside
 * this module needs them individually.
 */
import type { ChangedFileEntry, ChangedFileStatus } from '@brainstrike/types';
import {
  Badge,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type TreeTableCellProps,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { AlertTriangle } from 'lucide-react';
import type { ReactElement } from 'react';
import type {
  ChangedFilesTreeNodeData,
  ChangedFilesWorktreeNodeData,
} from './changed-files-tree-model';

const STATUS_LABEL: Record<ChangedFileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  untracked: '?',
};

const STATUS_COLOR_CLASS: Record<ChangedFileStatus, string> = {
  added: 'text-emerald-500',
  deleted: 'text-red-500',
  modified: 'text-amber-500',
  renamed: 'text-sky-500',
  untracked: 'text-emerald-500',
};

/** Last path segment for a display label. Never applied to a `WorktreeDescriptor.path` — that one is canonicalized and must use `descriptor.name` instead (see `changed-files-tree.tsx`'s module doc comment). */
export function lastPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

function ChangeStatsCell({ entry }: { readonly entry: ChangedFileEntry }): ReactElement {
  return (
    <span className="flex items-center justify-end gap-1.5 font-mono text-[11px] tabular-nums">
      <span
        className={
          entry.additions === null
            ? 'text-muted-foreground'
            : 'text-emerald-600 dark:text-emerald-400'
        }
      >
        {entry.additions === null ? '—' : `+${entry.additions}`}
      </span>
      <span
        className={
          entry.deletions === null ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400'
        }
      >
        {entry.deletions === null ? '—' : `-${entry.deletions}`}
      </span>
    </span>
  );
}

function FileNameCell({ entry }: { readonly entry: ChangedFileEntry }): ReactElement {
  const displayPath =
    entry.status === 'renamed' && entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className={`w-4 shrink-0 text-center font-mono font-semibold text-[10px] ${STATUS_COLOR_CLASS[entry.status]}`}
      >
        {STATUS_LABEL[entry.status]}
      </span>
      <span className="truncate text-xs" title={displayPath}>
        {displayPath}
      </span>
    </span>
  );
}

function WorktreeTrustBadge({
  trustReason,
}: {
  readonly trustReason: string | null;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
          data-testid="changed-files-worktree-trust-badge"
          variant="outline"
        >
          <AlertTriangle aria-hidden="true" className="size-3" />
          Unvalidated
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {trustReason ?? 'This worktree could not be verified against its own .git.'}
      </TooltipContent>
    </Tooltip>
  );
}

function WorktreeNameCell({ data }: { readonly data: ChangedFilesWorktreeNodeData }): ReactElement {
  const { descriptor, worktreePath } = data;
  // WorktreeDescriptor.path is canonicalized — never basename() it for
  // display when a descriptor resolved; descriptor.name is the source of
  // truth. Falling back to the raw worktreePath (not basenamed) only when no
  // descriptor is available keeps that rule intact without fabricating a name.
  const label = descriptor?.name ?? worktreePath;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-medium text-xs" title={worktreePath}>
        {label}
      </span>
      {descriptor?.branch ? (
        <span className="truncate text-[10px] text-muted-foreground">{descriptor.branch}</span>
      ) : null}
      {descriptor?.trust === 'unvalidated' ? (
        <WorktreeTrustBadge trustReason={descriptor.trustReason} />
      ) : null}
    </span>
  );
}

function NameCell({ node }: TreeTableCellProps<ChangedFilesTreeNodeData>): ReactElement | null {
  const { data } = node;
  switch (data.kind) {
    case 'root':
      return (
        <span className="truncate font-medium text-xs" title={data.rootId}>
          {data.rootId}
        </span>
      );
    case 'outside-roots':
      return (
        <span className="truncate font-medium text-muted-foreground text-xs">
          Outside workspace roots
        </span>
      );
    case 'repository':
      return (
        <span className="truncate font-medium text-xs" title={data.repositoryRoot}>
          {lastPathSegment(data.repositoryRoot)}
        </span>
      );
    case 'worktree':
      return <WorktreeNameCell data={data} />;
    case 'file':
      return <FileNameCell entry={data.entry} />;
    default:
      return null;
  }
}

function StatsCell({ node }: TreeTableCellProps<ChangedFilesTreeNodeData>): ReactElement | null {
  return node.data.kind === 'file' ? <ChangeStatsCell entry={node.data.entry} /> : null;
}

// Exported so `changed-files-tree-render-stability.test.tsx` can wrap `cell`
// with a render-counting spy without needing to inject columns as a prop —
// this component's columns are a fixed internal concern, not a
// caller-configurable one.
export const CHANGED_FILES_TREE_COLUMNS: TreeTableColumn<ChangedFilesTreeNodeData>[] = [
  {
    cell: NameCell,
    header: 'Name',
    id: 'name',
    minWidth: 200,
  },
  {
    cell: StatsCell,
    className: 'text-right',
    header: 'Changes',
    headerContentClassName: 'justify-end',
    id: 'stats',
    resizable: false,
    width: 96,
  },
];
