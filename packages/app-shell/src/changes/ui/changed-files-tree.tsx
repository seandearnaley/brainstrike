/**
 * `ChangedFilesTree` (BST-1114, W4 Task B): the canonical-`TreeTable`-backed
 * file tree for the Changes surface — root workspace → repository →
 * worktree → file, tri-state checkbox selection, expand/collapse. See
 * `changed-files-tree-model.ts` for the grouping decision (flat under the
 * worktree) and the identity-stability mechanism.
 *
 * Visual language matches `git-panel/git-changes-view.tsx` (status letters,
 * ± chips, row density) but the STRUCTURE is the canonical `TreeTable` from
 * `@brainstrike/ui`, not a hand-rolled list — per BST-1114's TreeTable
 * consolidation.
 *
 * CHECKBOX SEMANTICS: a file's checkbox is checked iff its
 * `changedFileKey` is IN `useChangesStore`'s `selectedFileKeys` (the literal
 * reading of that store's own doc comment — "the user checked"). Nothing
 * checked is therefore the NEUTRAL default, not "hide everything": per the
 * store's SELECTION SEMANTICS, an empty `selectedFileKeys` renders every
 * file, so "check nothing" (the default) and "check everything" (every file
 * explicitly checked) are two distinct, both-reachable states that happen to
 * render the same file set — never a lossy "select none" state, which this
 * store cannot represent (see `changes-store.test.ts`).
 *
 * SELECTION WRITES FILE KEYS ONLY: checking a group cascades to its
 * descendant FILE ids only (never the group's own node id) — group ids are
 * this component's own tree-structure concern and must never leak into
 * `selectedFileKeys`, which `changeset-diff-pane.tsx` matches directly
 * against `changedFileKey(entry)`. This is also why selection uses the
 * PLUGGABLE `getCheckboxState`/`onCheckboxChange` path rather than
 * TreeTable's built-in `multiSelectedIds` cascade: the built-in cascade adds
 * every DESCENDANT NODE id (files AND groups) to the selection set on a
 * parent toggle, which would pollute the store.
 *
 * CONTEXT MENU SEAM (for Task D — do not implement here, do not touch
 * `packages/context-actions/src/types.ts`): TreeTable already exposes
 * `onRowContextMenu?: (nodeId, node, event) => void`, which this component
 * intentionally leaves unset. Task D wires a `contextmenu` handler by
 * passing that prop on the `<TreeTable>` below, switching on
 * `node.data.kind` — `'file'` maps to a `changed-file` `ContextTarget` from
 * `node.data.entry`, `'worktree'` maps to a `worktree` `ContextTarget` from
 * `node.data.worktreePath`/`node.data.descriptor`. No restructuring needed.
 */
import type { ChangedFileEntry, ChangedFileStatus, GitInventory } from '@brainstrike/types';
import {
  Badge,
  LoadingFallback,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TreeTable,
  type TreeTableCellProps,
  type TreeTableCheckboxNextState,
  type TreeTableCheckboxRenderState,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { AlertTriangle } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react';
import { useChangesStore } from '../changes-store';
import {
  buildChangedFilesTree,
  type ChangedFilesTreeNode,
  type ChangedFilesTreeNodeData,
  type ChangedFilesWorktreeNodeData,
} from './changed-files-tree-model';

export interface ChangedFilesTreeProps {
  readonly files: readonly ChangedFileEntry[];
  readonly inventory: GitInventory | null;
  readonly loading?: boolean;
}

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

/** Last path segment for a display label. Never applied to a `WorktreeDescriptor.path` — that one is canonicalized and must use `descriptor.name` instead (see module doc comment). */
function lastPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

function EmptyChangedFiles(): ReactElement {
  return (
    <div
      className="flex h-32 items-center justify-center px-6 text-center text-muted-foreground text-sm"
      data-testid="changed-files-tree-empty"
    >
      No changed files.
    </div>
  );
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

// Exported (not part of the fixed component contract) so
// `changed-files-tree-render-stability.test.tsx` can wrap `cell` with a
// render-counting spy without needing to inject columns as a prop — this
// component's columns are a fixed internal concern, not a caller-configurable
// one.
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

interface ChangedFilesTreeIndexes {
  readonly descendantFileKeysById: ReadonlyMap<string, readonly string[]>;
}

/** Per-group descendant FILE ids (never group ids — see the SELECTION WRITES module doc comment). */
function buildTreeIndexes(nodes: readonly ChangedFilesTreeNode[]): ChangedFilesTreeIndexes {
  const childrenByParentId = new Map<string | null, ChangedFilesTreeNode[]>();
  for (const node of nodes) {
    const siblings = childrenByParentId.get(node.parentId);
    if (siblings) {
      siblings.push(node);
    } else {
      childrenByParentId.set(node.parentId, [node]);
    }
  }

  const descendantFileKeysById = new Map<string, readonly string[]>();
  function collect(node: ChangedFilesTreeNode): readonly string[] {
    const cached = descendantFileKeysById.get(node.id);
    if (cached) {
      return cached;
    }
    if (node.data.kind === 'file') {
      const self = [node.id];
      descendantFileKeysById.set(node.id, self);
      return self;
    }
    const keys: string[] = [];
    for (const child of childrenByParentId.get(node.id) ?? []) {
      keys.push(...collect(child));
    }
    descendantFileKeysById.set(node.id, keys);
    return keys;
  }
  for (const node of nodes) {
    collect(node);
  }

  return { descendantFileKeysById };
}

function describeGroupNode(data: ChangedFilesTreeNodeData): string {
  switch (data.kind) {
    case 'root':
      return `root ${data.rootId}`;
    case 'repository':
      return lastPathSegment(data.repositoryRoot);
    case 'worktree':
      return data.descriptor?.name ?? data.worktreePath;
    case 'outside-roots':
      return 'files outside workspace roots';
    default:
      return 'this group';
  }
}

export function ChangedFilesTree({
  files,
  inventory,
  loading = false,
}: ChangedFilesTreeProps): ReactElement {
  const selectedFileKeys = useChangesStore((state) => state.selectedFileKeys);
  const expandedIds = useChangesStore((state) => state.expandedIds);
  const setSelectedFileKeys = useChangesStore((state) => state.setSelectedFileKeys);
  const setExpandedIds = useChangesStore((state) => state.setExpandedIds);
  const toggleExpanded = useChangesStore((state) => state.toggleExpanded);

  const nodes = useMemo(() => buildChangedFilesTree(files, inventory), [files, inventory]);
  const { descendantFileKeysById } = useMemo(() => buildTreeIndexes(nodes), [nodes]);

  const groupNodeIds = useMemo(
    () => nodes.filter((node) => node.data.kind !== 'file').map((node) => node.id),
    [nodes]
  );
  // Expand everything on first load of a changeset, without stomping state
  // the user (or a previous mount) already set. Runs at most once per
  // component instance — see the module doc comment's module-vs-instance
  // note for why "first load" is scoped to the mount, not the changeset id.
  const hasAutoExpandedRef = useRef(false);
  useEffect(() => {
    if (hasAutoExpandedRef.current) {
      return;
    }
    hasAutoExpandedRef.current = true;
    if (expandedIds.size > 0 || groupNodeIds.length === 0) {
      return;
    }
    setExpandedIds(new Set(groupNodeIds));
  }, []);

  const getCheckboxState = useCallback(
    (node: ChangedFilesTreeNode): TreeTableCheckboxRenderState => {
      if (node.data.kind === 'file') {
        return selectedFileKeys.has(node.id) ? 'checked' : 'unchecked';
      }
      const fileKeys = descendantFileKeysById.get(node.id) ?? [];
      if (fileKeys.length === 0) {
        return 'unchecked';
      }
      let checkedCount = 0;
      for (const key of fileKeys) {
        if (selectedFileKeys.has(key)) {
          checkedCount += 1;
        }
      }
      if (checkedCount === 0) {
        return 'unchecked';
      }
      return checkedCount === fileKeys.length ? 'checked' : 'indeterminate';
    },
    [descendantFileKeysById, selectedFileKeys]
  );

  const handleCheckboxChange = useCallback(
    (node: ChangedFilesTreeNode, nextState: TreeTableCheckboxNextState) => {
      const fileKeys =
        node.data.kind === 'file' ? [node.id] : (descendantFileKeysById.get(node.id) ?? []);
      if (fileKeys.length === 0) {
        return;
      }
      const next = new Set(selectedFileKeys);
      if (nextState === 'checked') {
        for (const key of fileKeys) {
          next.add(key);
        }
      } else {
        for (const key of fileKeys) {
          next.delete(key);
        }
      }
      setSelectedFileKeys(next);
    },
    [descendantFileKeysById, selectedFileKeys, setSelectedFileKeys]
  );

  const getCheckboxAriaLabel = useCallback((node: ChangedFilesTreeNode): string => {
    if (node.data.kind === 'file') {
      return `Select ${node.data.entry.path}`;
    }
    return `Select all files in ${describeGroupNode(node.data)}`;
  }, []);

  if (loading) {
    return <LoadingFallback message="Loading changed files…" />;
  }

  return (
    <TreeTable
      ariaLabel="Changed files"
      columns={CHANGED_FILES_TREE_COLUMNS}
      emptyState={<EmptyChangedFiles />}
      expandedIds={expandedIds}
      getCheckboxAriaLabel={getCheckboxAriaLabel}
      getCheckboxState={getCheckboxState}
      nodes={nodes as ChangedFilesTreeNode[]}
      onCheckboxChange={handleCheckboxChange}
      onToggleExpand={toggleExpanded}
      selectionMode="none"
      showCheckbox={true}
    />
  );
}
