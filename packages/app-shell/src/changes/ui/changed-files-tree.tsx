/**
 * `ChangedFilesTree` (BST-1114, W4 Task B): the canonical-`TreeTable`-backed
 * file tree for the Changes surface — root workspace → repository →
 * worktree → file, tri-state checkbox selection, expand/collapse. See
 * `changed-files-tree-model.ts` for the grouping decision (flat under the
 * worktree) and the identity-stability mechanism. Cell renderers and column
 * definitions live in `changed-files-tree-columns.tsx` (kept out of this
 * file so it exports components only — `react-doctor/only-export-components`).
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
  type TreeTableCheckboxNextState,
  type TreeTableCheckboxRenderState,
  useContextMenuTarget,
} from '@brainstrike/ui';
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react';
import { useChangesStore } from '../changes-store';
import { CHANGED_FILES_TREE_COLUMNS, lastPathSegment } from './changed-files-tree-columns';
import {
  buildChangedFilesTree,
  type ChangedFilesTreeNode,
  type ChangedFilesTreeNodeData,
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
  /**
   * Root group display labels keyed by rootId (workspace display name /
   * path-basename fallback — build with `useRootLabelById`). Defaults to
   * empty; an unlabeled root renders a generic label, never the raw UUID.
   */
  readonly rootLabelById?: ReadonlyMap<string, string>;
  /** See module doc comment. Defaults to empty — every root resolves to `null`. */
  readonly rootPathById?: ReadonlyMap<string, string>;
}

const EMPTY_ROOT_PATHS: ReadonlyMap<string, string> = new Map();
const EMPTY_ROOT_LABELS: ReadonlyMap<string, string> = new Map();

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
      return `root ${data.label ?? data.rootId}`;
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
  rootLabelById = EMPTY_ROOT_LABELS,
  rootPathById = EMPTY_ROOT_PATHS,
}: ChangedFilesTreeProps): ReactElement {
  const selectedFileKeys = useChangesStore((state) => state.selectedFileKeys);
  const expandedIds = useChangesStore((state) => state.expandedIds);
  const setSelectedFileKeys = useChangesStore((state) => state.setSelectedFileKeys);
  const setExpandedIds = useChangesStore((state) => state.setExpandedIds);
  const toggleExpanded = useChangesStore((state) => state.toggleExpanded);

  const nodes = useMemo(
    () => buildChangedFilesTree(files, inventory, rootLabelById),
    [files, inventory, rootLabelById]
  );
  const { descendantFileKeysById } = useMemo(() => buildTreeIndexes(nodes), [nodes]);

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
  const handleRowContextMenu = useCallback(
    (_nodeId: string, node: ChangedFilesTreeNode) => {
      setContextMenuTarget(nodeToContextTarget(node, rootPathById));
    },
    [rootPathById, setContextMenuTarget]
  );
  const resetContextMenuTarget = useCallback(() => {
    setContextMenuTarget(null);
  }, [setContextMenuTarget]);

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
          getCheckboxAriaLabel={getCheckboxAriaLabel}
          getCheckboxState={getCheckboxState}
          nodes={nodes}
          onCheckboxChange={handleCheckboxChange}
          onRowContextMenu={handleRowContextMenu}
          onToggleExpand={toggleExpanded}
          selectionMode="none"
          showCheckbox={true}
        />
      </div>
    </ActionContextMenu>
  );
}
