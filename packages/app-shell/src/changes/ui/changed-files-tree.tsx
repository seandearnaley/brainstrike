/**
 * `ChangedFilesTree` (BST-1114, W4 Task B): the canonical-`TreeTable`-backed
 * file tree for the Changes surface — root workspace → repository →
 * worktree → file, expand/collapse. Choosing a file hands it to `onSelectFile`,
 * which scrolls the diff to it. See
 * `changed-files-tree-model.ts` for the grouping decision (flat under the
 * worktree) and the identity-stability mechanism. Cell renderers and column
 * definitions live in `changed-files-tree-columns.tsx` (kept out of this
 * file so it exports components only — `react-refresh/only-export-components`).
 *
 * CONTEXT MENU: rows claim a `ContextTarget` synchronously in
 * `onRowContextMenu` (`'file'` -> `changed-file`, `'worktree'` -> `worktree`),
 * following `docs/agents/ui-conventions.md`'s recipe and
 * `optimized-file-tree.tsx`'s wiring: a capture-phase reset on the container
 * clears the target before any row handler runs, so an unclaimed right-click
 * (a repository or root group row, or a worktree with no resolved descriptor)
 * leaves the target `null` and `ActionContextMenu` suppresses the empty menu
 * rather than showing a dead one. `setTarget` is destructured because the
 * controller object is NOT referentially stable, and an unstable handler here
 * would defeat TreeTable's row memoization.
 *
 * `rootPathById` resolves the `changed-file` target's `rootPath` field for a
 * journal-sourced entry (`worktreePath: null`, real `rootId`): without it,
 * `changes.open-file`/`changes.reveal-file` gate on `worktreePath` alone and
 * can never resolve an absolute path for an agent-edited file, so the
 * right-click menu is empty for the flagship "→ Review" flow. Absent/unknown
 * root ids resolve to `null` — never fabricated.
 */

import type { ContextTarget } from '@brainstrike/context-actions';
import type { ChangedFileEntry, GitInventory } from '@brainstrike/types';
import {
  ActionContextMenu,
  LoadingFallback,
  TreeTable,
  useContextMenuTarget,
} from '@brainstrike/ui';
import { type ReactElement, useEffect, useMemo, useRef } from 'react';
import { useChangesStore } from '../changes-store';
import { CHANGED_FILES_TREE_COLUMNS } from './changed-files-tree-columns';
import {
  buildChangedFilesTree,
  type ChangedFilesTreeNode,
  repositoryRootFromNodeId,
} from './changed-files-tree-model';

export interface ChangedFilesTreeProps {
  /**
   * Structural identity of the active changeset. Scopes the first-load
   * auto-expand so switching source re-expands the NEW tree instead of
   * leaving it collapsed (the surface stays mounted for the whole session).
   */
  readonly changesetKey: string;
  readonly files: readonly ChangedFileEntry[];
  readonly inventory: GitInventory | null;
  readonly loading?: boolean;
  /** Called with the file a person chooses. */
  readonly onSelectFile?: ((entry: ChangedFileEntry) => void) | undefined;
  /**
   * Root group display labels keyed by rootId (workspace display name /
   * path-basename fallback — build with `useRootLabelById`). Defaults to
   * empty; an unlabeled root renders a generic label, never the raw UUID.
   */
  readonly rootLabelById?: ReadonlyMap<string, string>;
  /** See module doc comment. Defaults to empty — every root resolves to `null`. */
  readonly rootPathById?: ReadonlyMap<string, string>;
  /** The chosen file's `changedFileKey`. */
  readonly selectedFileKey?: string | null | undefined;
}

const EMPTY_ROOT_PATHS: ReadonlyMap<string, string> = new Map();

/**
 * Painted pitch of one row, in px: the 24px disclosure control with its
 * `my-0.5` margins, plus the 1px row border; the same pitch as the
 * Explorer's tree (`optimized-file-tree.tsx`). A numeric height turns off
 * TreeTable's per-row measurement, so this must equal what the browser paints.
 */
const ROW_HEIGHT = 29;
const EMPTY_ROOT_LABELS: ReadonlyMap<string, string> = new Map();

function EmptyChangedFiles(): ReactElement {
  return (
    <div
      className="text-muted-foreground flex h-32 items-center justify-center px-6 text-center text-sm"
      data-testid="changed-files-tree-empty"
    >
      No changed files.
    </div>
  );
}

/**
 * Node -> `ContextTarget` adapter. Returns `null` for any row that has no
 * actionable identity — group rows, and a worktree whose descriptor the
 * inventory has not resolved (its `name`/`trust` are genuinely unknown, and
 * fabricating them to satisfy the target shape is exactly the silent
 * degradation this surface must not do).
 */
function nodeToContextTarget(
  node: ChangedFilesTreeNode,
  rootPathById: ReadonlyMap<string, string>
): ContextTarget | null {
  if (node.data.kind === 'file') {
    const { entry } = node.data;
    return {
      kind: 'changed-file',
      path: entry.path,
      repositoryRoot: entry.repositoryRoot,
      rootId: entry.rootId,
      rootPath: entry.rootId === null ? null : (rootPathById.get(entry.rootId) ?? null),
      worktreePath: entry.worktreePath,
    };
  }
  if (node.data.kind === 'worktree') {
    const { descriptor } = node.data;
    const repositoryRoot = repositoryRootFromNodeId(node.parentId);
    if (!(descriptor && repositoryRoot)) {
      return null;
    }
    return {
      branch: descriptor.branch,
      containment: descriptor.containment,
      kind: 'worktree',
      name: descriptor.name,
      path: descriptor.path,
      repositoryRoot,
      trust: descriptor.trust,
      trustReason: descriptor.trustReason,
    };
  }
  return null;
}

export function ChangedFilesTree({
  changesetKey,
  files,
  inventory,
  loading = false,
  onSelectFile,
  rootLabelById = EMPTY_ROOT_LABELS,
  rootPathById = EMPTY_ROOT_PATHS,
  selectedFileKey = null,
}: ChangedFilesTreeProps): ReactElement {
  const expandedIds = useChangesStore((state) => state.expandedIds);
  const setExpandedIds = useChangesStore((state) => state.setExpandedIds);
  const toggleExpanded = useChangesStore((state) => state.toggleExpanded);

  const nodes = buildChangedFilesTree(files, inventory, rootLabelById);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const groupNodeIds = useMemo(() => {
    const ids: string[] = [];
    for (const node of nodes) {
      if (node.data.kind !== 'file') {
        ids.push(node.id);
      }
    }
    return ids;
  }, [nodes]);
  // Expand everything on the first POPULATED render of each changeset.
  //
  // Scoped to `changesetKey`, not to the mount: the surface stays mounted for
  // the whole session (`KeepMountedRoute`), so a mount-scoped latch would
  // auto-expand only the first changeset the user ever opened.
  //
  // The latch is written only AFTER the bail-outs. The tree mounts the instant
  // a changeset is selected, while `useChangeset`'s view is still resolving —
  // so the first run always sees `files === []` and no group nodes. Latching
  // before that check burns the one shot on an empty tree and leaves the real
  // file list collapsed forever.
  const autoExpandedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoExpandedKeyRef.current === changesetKey || groupNodeIds.length === 0) {
      return;
    }
    autoExpandedKeyRef.current = changesetKey;
    setExpandedIds(new Set(groupNodeIds));
  }, [changesetKey, groupNodeIds, setExpandedIds]);

  // Destructure `setTarget` (stable) rather than depending on the controller
  // object, which is not referentially stable — see the module doc comment.
  const contextMenuController = useContextMenuTarget();
  const { setTarget: setContextMenuTarget } = contextMenuController;
  const handleRowContextMenu = (_nodeId: string, node: ChangedFilesTreeNode) => {
    setContextMenuTarget(nodeToContextTarget(node, rootPathById));
  };
  const resetContextMenuTarget = () => {
    setContextMenuTarget(null);
  };

  const handleSelect = (nodeId: string | null) => {
    const node = nodeId === null ? undefined : nodeById.get(nodeId);
    if (node?.data.kind === 'file') {
      onSelectFile?.(node.data.entry);
    }
  };

  if (loading) {
    return <LoadingFallback message="Loading changed files…" />;
  }

  return (
    <ActionContextMenu controller={contextMenuController}>
      {/* Capture-phase reset runs BEFORE any row handler, so every
          right-click starts from a clean target and an unclaimed one
          suppresses the menu instead of reusing the previous row's. */}
      <div
        className="h-full min-h-0"
        data-testid="changed-files-tree"
        onContextMenuCapture={resetContextMenuTarget}
      >
        <TreeTable
          ariaLabel="Changed files"
          columns={CHANGED_FILES_TREE_COLUMNS}
          emptyState={<EmptyChangedFiles />}
          expandedIds={expandedIds}
          nodes={nodes}
          onRowContextMenu={handleRowContextMenu}
          onSelect={handleSelect}
          onToggleExpand={toggleExpanded}
          rowHeight={ROW_HEIGHT}
          selectedId={selectedFileKey}
          selectionMode="single"
        />
      </div>
    </ActionContextMenu>
  );
}
