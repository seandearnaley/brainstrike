import {
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
  type TreeTableHandle,
} from '@brainstrike/ui';
import { AlertTriangle, FileText, Folder, Info } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react';
import type { MiniTreeEntry } from './breadcrumb-mini-tree-entries';

/**
 * Breadcrumb popover navigator (BST-1319), rendered through the shared
 * TreeTable per the ui-conventions treegrid contract — virtualization, ARIA
 * row metadata (level/posinset/setsize), and roving keyboard focus all come
 * from the canonical implementation instead of a package-local tree. The
 * clicked segment is highlighted (single selection); activating a file picks
 * it, activating a directory toggles expansion; synthetic error entries
 * render as inert rows.
 */
export interface BreadcrumbMiniTreeProps {
  readonly entries: readonly MiniTreeEntry[];
  readonly expandedPaths: ReadonlySet<string>;
  readonly loadingPaths: ReadonlySet<string>;
  readonly onPickFile: (path: string) => void;
  readonly onToggleDir: (path: string) => void;
  /** The clicked breadcrumb segment's path — highlighted, scrolled into view. */
  readonly selectedPath: string;
}

const ROW_HEIGHT = 26;

function entryId(entry: MiniTreeEntry): string {
  return entry.kind === 'node' ? entry.node.path : entry.path;
}

const COLUMNS: TreeTableColumn<MiniTreeEntry>[] = [
  {
    cell: ({ node }) => {
      const entry = node.data;
      if (entry.kind !== 'node') {
        // Inert synthetic rows: failed child loads (error) and partial
        // listings (notice) both surface visibly instead of vanishing.
        const Icon = entry.kind === 'error' ? AlertTriangle : Info;
        return (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <Icon
              aria-hidden="true"
              className={`h-3.5 w-3.5 flex-shrink-0 ${entry.kind === 'error' ? 'text-warning' : ''}`}
            />
            <span className="truncate italic">{entry.message}</span>
          </span>
        );
      }
      const isDir = entry.node.type === 'directory';
      return (
        <span className="flex min-w-0 items-center gap-1.5" title={entry.node.path}>
          {isDir ? (
            <Folder aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
          ) : (
            <FileText
              aria-hidden="true"
              className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate">{entry.node.name}</span>
        </span>
      );
    },
    id: 'name',
    resizable: false,
  },
];

export function BreadcrumbMiniTree({
  entries,
  expandedPaths,
  loadingPaths,
  onPickFile,
  onToggleDir,
  selectedPath,
}: BreadcrumbMiniTreeProps): ReactElement {
  // Entries arrive as a DFS-ordered visible row model — hand TreeTable the
  // pre-flattened rows (parent ids reconstructed from the depth stack) so it
  // skips recursive flattening but keeps virtualization + ARIA row metadata.
  const nodes = useMemo(() => {
    const stack: string[] = [];
    return entries.map((entry): TreeNode<MiniTreeEntry> => {
      stack.length = entry.depth;
      const parentId = entry.depth === 0 ? null : (stack[entry.depth - 1] ?? null);
      const id = entryId(entry);
      if (entry.kind === 'node' && entry.node.type === 'directory') {
        stack[entry.depth] = id;
      }
      return {
        data: entry,
        depth: entry.depth,
        hasChildren: entry.kind === 'node' && entry.node.type === 'directory',
        id,
        parentId,
        type: entry.kind === 'node' ? entry.node.type : entry.kind,
      };
    });
  }, [entries]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const loadingNodeIds = useMemo(() => new Set(loadingPaths), [loadingPaths]);

  const handleSelect = useCallback(
    (nodeId: string | null) => {
      if (nodeId === null) {
        return;
      }
      const entry = nodeById.get(nodeId)?.data;
      if (entry?.kind !== 'node') {
        return;
      }
      if (entry.node.type === 'directory') {
        onToggleDir(entry.node.path);
        return;
      }
      onPickFile(entry.node.path);
    },
    [nodeById, onPickFile, onToggleDir]
  );

  // Land on the clicked segment: reveal scrolls its row into the virtualized
  // window once on mount (entries for the initial listing are already there).
  const handleRef = useRef<TreeTableHandle | null>(null);
  const revealedRef = useRef(false);
  useEffect(() => {
    if (revealedRef.current || !nodeById.has(selectedPath)) {
      return;
    }
    revealedRef.current = true;
    handleRef.current?.revealNode(selectedPath);
  }, [nodeById, selectedPath]);

  return (
    <div className="flex max-h-72 min-h-0 flex-col" data-testid="breadcrumb-mini-tree">
      <TreeTable
        ariaLabel="Breadcrumb navigator"
        columns={COLUMNS}
        expandedIds={expandedPaths}
        loadingNodeIds={loadingNodeIds}
        maxHeight="288px"
        nodes={nodes}
        nodesArePreFlattened={true}
        onSelect={handleSelect}
        onToggleExpand={onToggleDir}
        overscan={12}
        rowClassName={(node) =>
          node.type === 'error' || node.type === 'notice' ? 'pointer-events-none' : ''
        }
        rowHeight={ROW_HEIGHT}
        selectedId={selectedPath}
        selectionMode="single"
        showHeader={false}
        treeTableRef={handleRef}
        windowingStrategy="virtual"
      />
    </div>
  );
}
