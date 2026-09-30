/**
 * `ChangedFilesTree`'s `TreeTable` column definitions and cell renderers
 * (BST-1114, W4 Task B), split out of `changed-files-tree.tsx` so that file
 * exports components only (`react-refresh/only-export-components`) — this
 * module exports the non-component `CHANGED_FILES_TREE_COLUMNS` array and
 * the `lastPathSegment` helper the main component also needs for its group
 * labels, and keeps every cell renderer file-local since nothing outside
 * this module needs them individually.
 */
import type { ChangedFileEntry } from '@brainstrike/types';
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
import { CHANGED_FILE_STATUS_PRESENTATION } from '../../git-status-presentation';
import type {
  ChangedFilesTreeNodeData,
  ChangedFilesWorktreeNodeData,
} from './changed-files-tree-model';

/** Last path segment for a display label. Never applied to a `WorktreeDescriptor.path` — that one is canonicalized and must use `descriptor.name` instead (see `changed-files-tree.tsx`'s module doc comment). */
export function lastPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

function ChangeStatsCell({ entry }: { readonly entry: ChangedFileEntry }): ReactElement {
  return (
    <span className="flex items-center justify-end gap-1.5 font-mono text-[11px] tabular-nums">
      <span className={entry.additions === null ? 'text-muted-foreground' : 'text-success'}>
        {entry.additions === null ? '—' : `+${entry.additions}`}
      </span>
      <span className={entry.deletions === null ? 'text-muted-foreground' : 'text-destructive'}>
        {entry.deletions === null ? '—' : `-${entry.deletions}`}
      </span>
    </span>
  );
}

function FileNameCell({ entry }: { readonly entry: ChangedFileEntry }): ReactElement {
  const presentation = CHANGED_FILE_STATUS_PRESENTATION[entry.status];
  const displayPath =
    entry.status === 'renamed' && entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-label={presentation.label}
        className={`w-4 shrink-0 text-center font-mono font-semibold text-[10px] ${presentation.className}`}
        role="img"
      >
        {presentation.glyph}
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
          className="gap-1 border-amber-500/40 text-warning"
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
      // The label is the root's display name (or the caller's path-basename
      // fallback) — NEVER the bare rootId UUID (BST-1164 review). A root the
      // caller could not label (e.g. no longer connected) gets a generic
      // label; the UUID survives only in the hover title for debugging.
      return (
        <span className="truncate font-medium text-xs" title={data.label ?? data.rootId}>
          {data.label ?? 'Workspace root'}
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
