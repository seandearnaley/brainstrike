/**
 * `ChangedFilesTree`'s pure adapter (BST-1114, W4 Task B): projects a
 * changeset's flat `ChangedFileEntry[]` into the canonical `TreeTable`'s
 * `TreeNode[]` shape.
 *
 * GROUPING DECISION (v1, deliberate — not an oversight): root workspace →
 * repository → worktree → FILE, with files listed FLAT under their worktree
 * (no directory sub-grouping). A changeset is typically a handful to a few
 * dozen files; an extra directory-nesting level buys nothing at that scale
 * and can be layered in later without touching this module's contract (a
 * directory group would slot between the worktree and file levels, with its
 * own `dir:<worktreePath>:<relativeDirPath>` id prefix and depth+1 per
 * segment). State this explicitly in the BST-1114 commit message.
 *
 * LOCATION FACTS ARE A THREE-WAY SPLIT, not a binary located/not-located
 * (review finding, BST-1114 PR #2274): a fully-located entry (`rootId` +
 * `repositoryRoot` + `worktreePath` all real) nests under
 * repository/worktree as above. A journal-sourced entry (`agent-run`/
 * `run-range` — `rootId` real, `repositoryRoot`/`worktreePath` both null,
 * per `journalFoldEntryToChangedFileEntry`) buckets as a direct FILE child
 * of its ROOT group instead: it names a real granted workspace root, it just
 * has no repository/worktree to nest under, so sweeping it into
 * `outside-roots` would be dishonest — that group is reserved for an entry
 * whose `rootId` is ALSO null (genuinely unlocatable, or outside every
 * granted root). Neither case is ever dropped. `inventory === null` only
 * affects worktree ENRICHMENT (name/branch/trust): the tree still builds
 * from `files`' own topology facts, never blocking on the inventory and
 * never fabricating names when it is absent.
 *
 * IDENTITY STABILITY (the hard requirement — see
 * `docs/agents/ui-conventions.md`'s TreeTable section and
 * `packages/ui/src/tree-table/tree-utils.ts`'s `reuseEqualFlattenedRows`):
 * TreeTable's own row-flatten reuse pass bails out per row only when
 * `a.node === b.node`. Two layers keep that true across rebuilds, mirroring
 * `packages/file-explorer-ui/src/tree/optimized-file-tree-model.ts`'s
 * `materializeNormalizedNodeStable` + `reuseEqualFileTreeRows` pair:
 *
 * 1. {@link fileLeafNodeCache} — a module-level `WeakMap` from a source
 *    `ChangedFileEntry` object to its materialized leaf `TreeNode`. An
 *    unchanged entry REFERENCE always projects to the same node object. This
 *    is a fast path only: it does nothing for a fresh-but-equal entry object
 *    (new reference, same field values).
 * 2. {@link reuseEqualChangedFilesTreeNodes} — a module-level "previous
 *    build" reuse pass (mirroring `reuseEqualFileTreeRows`) that compares
 *    every freshly built node (group OR leaf) against the PREVIOUS call's
 *    node with the same id by VALUE, not reference. This is what makes a
 *    fresh-but-equal `files` array — a new array, or even new-but-
 *    field-identical entry objects — still yield `===` nodes for every
 *    unchanged row, which the WeakMap alone cannot guarantee.
 *
 * The "previous build" state is intentionally module-level rather than
 * per-caller: the Changes surface pairs 1:1 with the singleton
 * `useChangesStore`, so there is realistically one active
 * `ChangedFilesTree` consumer at a time, same as the store itself. Two
 * simultaneous consumers (e.g. two tests interleaving calls) still produce
 * CORRECT trees — reuse is by value-equality, so a stale "previous" entry
 * from an unrelated caller can only cause a missed reuse (a fresh node
 * where one could have been shared), never a wrong one.
 */
import type { ChangedFileEntry, GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import type { TreeNode } from '@brainstrike/ui';
import { changedFileKey } from '../changes-store';

interface ChangedFilesRootNodeData {
  readonly kind: 'root';
  /**
   * Human-readable name for the root group row (BST-1164 review): the
   * workspace root's display name, or the caller's path-basename fallback —
   * resolved from `rootLabelById` at build time. `null` when the caller has
   * no label for this root (e.g. it is no longer connected); the renderer
   * must then show a generic label, NEVER the bare `rootId` UUID.
   */
  readonly label: string | null;
  readonly rootId: string;
}

interface ChangedFilesOutsideRootsNodeData {
  readonly kind: 'outside-roots';
}

interface ChangedFilesRepositoryNodeData {
  readonly kind: 'repository';
  readonly repositoryRoot: string;
}

export interface ChangedFilesWorktreeNodeData {
  /** Resolved from `inventory` by path, or `null` when not (yet) known — never fabricated. */
  readonly descriptor: WorktreeDescriptor | null;
  readonly kind: 'worktree';
  readonly worktreePath: string;
}

interface ChangedFilesFileNodeData {
  readonly entry: ChangedFileEntry;
  readonly kind: 'file';
}

export type ChangedFilesTreeNodeData =
  | ChangedFilesRootNodeData
  | ChangedFilesOutsideRootsNodeData
  | ChangedFilesRepositoryNodeData
  | ChangedFilesWorktreeNodeData
  | ChangedFilesFileNodeData;

export type ChangedFilesTreeNode = TreeNode<ChangedFilesTreeNodeData>;

/** Id of the single, explicit group holding files that are not fully located (see module doc comment). */
export const OUTSIDE_ROOTS_NODE_ID = 'outside-roots';

function rootNodeId(rootId: string): string {
  return `root:${rootId}`;
}

/** Node-id prefix for repository group rows. Exported so a consumer can
 * recover the owning repository of a child row from `TreeNode.parentId`
 * without the model having to duplicate `repositoryRoot` onto every node. */
const REPOSITORY_NODE_ID_PREFIX = 'repo:';

function repositoryNodeId(repositoryRoot: string): string {
  return `${REPOSITORY_NODE_ID_PREFIX}${repositoryRoot}`;
}

/** Inverse of {@link repositoryNodeId}; `null` for any id that is not a repository row. */
export function repositoryRootFromNodeId(nodeId: string | null): string | null {
  if (nodeId === null || !nodeId.startsWith(REPOSITORY_NODE_ID_PREFIX)) {
    return null;
  }
  return nodeId.slice(REPOSITORY_NODE_ID_PREFIX.length);
}

function worktreeNodeId(worktreePath: string): string {
  return `worktree:${worktreePath}`;
}

type LocatedChangedFileEntry = ChangedFileEntry & {
  readonly repositoryRoot: string;
  readonly rootId: string;
  readonly worktreePath: string;
};

function isFullyLocated(entry: ChangedFileEntry): entry is LocatedChangedFileEntry {
  return entry.rootId !== null && entry.repositoryRoot !== null && entry.worktreePath !== null;
}

function buildWorktreeDescriptorIndex(
  inventory: GitInventory | null
): ReadonlyMap<string, WorktreeDescriptor> {
  const index = new Map<string, WorktreeDescriptor>();
  if (!inventory) {
    return index;
  }
  for (const repository of inventory.repositories) {
    for (const worktree of repository.worktrees) {
      index.set(worktree.path, worktree);
    }
  }
  return index;
}

// Fast-path cache only — see module doc comment point 1. Keyed by the source
// entry's own object identity, so it never needs invalidation: a changed
// entry is, by construction, a different object.
const fileLeafNodeCache = new WeakMap<ChangedFileEntry, ChangedFilesTreeNode>();

function materializeFileLeafNode(
  entry: ChangedFileEntry,
  parentId: string,
  depth: number
): ChangedFilesTreeNode {
  const cached = fileLeafNodeCache.get(entry);
  if (cached) {
    return cached;
  }
  const node: ChangedFilesTreeNode = {
    data: { entry, kind: 'file' },
    depth,
    hasChildren: false,
    id: changedFileKey(entry),
    parentId,
    type: 'file',
  };
  fileLeafNodeCache.set(entry, node);
  return node;
}

interface WorktreeBucket {
  readonly files: ChangedFileEntry[];
  readonly worktreePath: string;
}

interface RepositoryBucket {
  readonly repositoryRoot: string;
  readonly worktreeOrder: string[];
  readonly worktrees: Map<string, WorktreeBucket>;
}

interface RootBucket {
  /**
   * Journal-sourced entries for this root (`worktreePath`/`repositoryRoot`
   * null, `rootId` real — every `agent-run`/`run-range` `ChangedFileEntry`).
   * Rendered as direct FILE children of the root group, never swept into
   * `outside-roots`: the entry names a real granted root, it just has no
   * repository/worktree to nest under.
   */
  readonly looseFiles: ChangedFileEntry[];
  readonly repoOrder: string[];
  readonly repos: Map<string, RepositoryBucket>;
  readonly rootId: string;
}

interface BucketedFiles {
  readonly outsideFiles: ChangedFileEntry[];
  readonly rootOrder: string[];
  readonly roots: Map<string, RootBucket>;
}

function getOrCreateRootBucket(
  roots: Map<string, RootBucket>,
  rootOrder: string[],
  rootId: string
): RootBucket {
  let root = roots.get(rootId);
  if (!root) {
    root = { looseFiles: [], repoOrder: [], repos: new Map(), rootId };
    roots.set(rootId, root);
    rootOrder.push(rootId);
  }
  return root;
}

/**
 * Groups files by (rootId → repositoryRoot → worktreePath), preserving
 * first-seen order at every level.
 *
 * Three-way split per entry, NOT two: `isFullyLocated` (repositoryRoot +
 * worktreePath + rootId all real) nests under repository/worktree as before;
 * a journal-sourced entry (`rootId` real, `worktreePath`/`repositoryRoot`
 * null) buckets directly under its ROOT as a loose file — it names a real
 * granted root, it just has no repository/worktree to nest under, so
 * `outside-roots` (reserved for a `rootId`-less entry — genuinely
 * unlocatable or outside every granted root) would be dishonest.
 */
function bucketFiles(files: readonly ChangedFileEntry[]): BucketedFiles {
  const roots = new Map<string, RootBucket>();
  const rootOrder: string[] = [];
  const outsideFiles: ChangedFileEntry[] = [];

  for (const entry of files) {
    if (!isFullyLocated(entry)) {
      if (entry.rootId === null) {
        outsideFiles.push(entry);
      } else {
        getOrCreateRootBucket(roots, rootOrder, entry.rootId).looseFiles.push(entry);
      }
      continue;
    }

    const root = getOrCreateRootBucket(roots, rootOrder, entry.rootId);

    let repository = root.repos.get(entry.repositoryRoot);
    if (!repository) {
      repository = {
        repositoryRoot: entry.repositoryRoot,
        worktreeOrder: [],
        worktrees: new Map(),
      };
      root.repos.set(entry.repositoryRoot, repository);
      root.repoOrder.push(entry.repositoryRoot);
    }

    let worktree = repository.worktrees.get(entry.worktreePath);
    if (!worktree) {
      worktree = { files: [], worktreePath: entry.worktreePath };
      repository.worktrees.set(entry.worktreePath, worktree);
      repository.worktreeOrder.push(entry.worktreePath);
    }
    worktree.files.push(entry);
  }

  return { outsideFiles, rootOrder, roots };
}

function appendWorktreeNodes(
  nodes: ChangedFilesTreeNode[],
  repository: RepositoryBucket,
  repoGroupId: string,
  descriptorIndex: ReadonlyMap<string, WorktreeDescriptor>
): void {
  for (const worktreePath of repository.worktreeOrder) {
    const worktree = repository.worktrees.get(worktreePath);
    if (!worktree) {
      continue;
    }
    const worktreeGroupId = worktreeNodeId(worktreePath);
    nodes.push({
      childCount: worktree.files.length,
      data: {
        descriptor: descriptorIndex.get(worktreePath) ?? null,
        kind: 'worktree',
        worktreePath,
      },
      depth: 2,
      hasChildren: worktree.files.length > 0,
      id: worktreeGroupId,
      parentId: repoGroupId,
      type: 'worktree',
    });

    for (const entry of worktree.files) {
      nodes.push(materializeFileLeafNode(entry, worktreeGroupId, 3));
    }
  }
}

function appendRepositoryNodes(
  nodes: ChangedFilesTreeNode[],
  root: RootBucket,
  rootGroupId: string,
  descriptorIndex: ReadonlyMap<string, WorktreeDescriptor>
): void {
  for (const repositoryRoot of root.repoOrder) {
    const repository = root.repos.get(repositoryRoot);
    if (!repository) {
      continue;
    }
    const repoGroupId = repositoryNodeId(repositoryRoot);
    nodes.push({
      childCount: repository.worktreeOrder.length,
      data: { kind: 'repository', repositoryRoot },
      depth: 1,
      hasChildren: repository.worktreeOrder.length > 0,
      id: repoGroupId,
      parentId: rootGroupId,
      type: 'repository',
    });

    appendWorktreeNodes(nodes, repository, repoGroupId, descriptorIndex);
  }
}

function appendOutsideRootsNodes(
  nodes: ChangedFilesTreeNode[],
  outsideFiles: readonly ChangedFileEntry[]
): void {
  if (outsideFiles.length === 0) {
    return;
  }
  nodes.push({
    childCount: outsideFiles.length,
    data: { kind: 'outside-roots' },
    depth: 0,
    hasChildren: true,
    id: OUTSIDE_ROOTS_NODE_ID,
    parentId: null,
    type: 'outside-roots',
  });
  for (const entry of outsideFiles) {
    nodes.push(materializeFileLeafNode(entry, OUTSIDE_ROOTS_NODE_ID, 1));
  }
}

function buildRawNodes(
  files: readonly ChangedFileEntry[],
  inventory: GitInventory | null,
  rootLabelById: ReadonlyMap<string, string>
): ChangedFilesTreeNode[] {
  const descriptorIndex = buildWorktreeDescriptorIndex(inventory);
  const { roots, rootOrder, outsideFiles } = bucketFiles(files);
  const nodes: ChangedFilesTreeNode[] = [];

  for (const rootId of rootOrder) {
    const root = roots.get(rootId);
    if (!root) {
      continue;
    }
    const rootGroupId = rootNodeId(rootId);
    const childCount = root.repoOrder.length + root.looseFiles.length;
    nodes.push({
      childCount,
      data: { kind: 'root', label: rootLabelById.get(rootId) ?? null, rootId },
      depth: 0,
      hasChildren: childCount > 0,
      id: rootGroupId,
      parentId: null,
      type: 'root',
    });

    appendRepositoryNodes(nodes, root, rootGroupId, descriptorIndex);
    // Journal-sourced entries for this root — direct FILE children of the
    // root group (see `bucketFiles`'s doc comment). Depth 1, the same level
    // as a repository group, since there is no repository/worktree to nest
    // under.
    for (const entry of root.looseFiles) {
      nodes.push(materializeFileLeafNode(entry, rootGroupId, 1));
    }
  }

  appendOutsideRootsNodes(nodes, outsideFiles);

  return nodes;
}

function changedFileEntryFieldsEqual(a: ChangedFileEntry, b: ChangedFileEntry): boolean {
  return (
    a === b ||
    (a.path === b.path &&
      a.status === b.status &&
      a.additions === b.additions &&
      a.deletions === b.deletions &&
      a.oldPath === b.oldPath &&
      a.repositoryRoot === b.repositoryRoot &&
      a.revertible === b.revertible &&
      a.rootId === b.rootId &&
      a.worktreePath === b.worktreePath)
  );
}

/** Compares only the fields this tree actually renders — see the model's worktree enrichment. */
function worktreeDescriptorDisplayEqual(
  a: WorktreeDescriptor | null,
  b: WorktreeDescriptor | null
): boolean {
  if (a === b) {
    return true;
  }
  if (!(a && b)) {
    return false;
  }
  return (
    a.name === b.name &&
    a.branch === b.branch &&
    a.trust === b.trust &&
    a.trustReason === b.trustReason
  );
}

function nodeDataEqual(a: ChangedFilesTreeNodeData, b: ChangedFilesTreeNodeData): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case 'root': {
      const other = b as typeof a;
      return a.rootId === other.rootId && a.label === other.label;
    }
    case 'outside-roots':
      return true;
    case 'repository': {
      const other = b as typeof a;
      return a.repositoryRoot === other.repositoryRoot;
    }
    case 'worktree': {
      const other = b as typeof a;
      return (
        a.worktreePath === other.worktreePath &&
        worktreeDescriptorDisplayEqual(a.descriptor, other.descriptor)
      );
    }
    case 'file': {
      const other = b as typeof a;
      return changedFileEntryFieldsEqual(a.entry, other.entry);
    }
    default:
      return true;
  }
}

function changedFilesTreeNodesEqual(a: ChangedFilesTreeNode, b: ChangedFilesTreeNode): boolean {
  return (
    a.id === b.id &&
    a.parentId === b.parentId &&
    a.depth === b.depth &&
    a.type === b.type &&
    a.hasChildren === b.hasChildren &&
    a.childCount === b.childCount &&
    nodeDataEqual(a.data, b.data)
  );
}

// See module doc comment point 2. Reused across calls so a rebuild whose
// nodes are value-equal to the PREVIOUS build's returns those same objects.
let previousNodesById: ReadonlyMap<string, ChangedFilesTreeNode> = new Map();

function reuseEqualChangedFilesTreeNodes(
  nodes: readonly ChangedFilesTreeNode[]
): ChangedFilesTreeNode[] {
  return nodes.map((node) => {
    const previous = previousNodesById.get(node.id);
    return previous && changedFilesTreeNodesEqual(previous, node) ? previous : node;
  });
}

const EMPTY_ROOT_LABELS: ReadonlyMap<string, string> = new Map();

/**
 * Projects changed files into TreeTable nodes: root workspace → repository →
 * worktree → file (flat under the worktree — see module doc comment for the
 * grouping decision and the identity-stability mechanism). `rootLabelById`
 * supplies each root group's display label (workspace display name, or the
 * caller's path-basename fallback — see `use-root-labels.ts`); an unmapped
 * root carries `label: null` and the renderer shows a generic label, never
 * the raw root UUID.
 */
export function buildChangedFilesTree(
  files: readonly ChangedFileEntry[],
  inventory: GitInventory | null,
  rootLabelById: ReadonlyMap<string, string> = EMPTY_ROOT_LABELS
): readonly ChangedFilesTreeNode[] {
  const rawNodes = buildRawNodes(files, inventory, rootLabelById);
  const stabilized = reuseEqualChangedFilesTreeNodes(rawNodes);
  previousNodesById = new Map(stabilized.map((node) => [node.id, node]));
  return stabilized;
}
