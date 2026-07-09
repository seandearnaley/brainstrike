import type { TreeNode } from '@brainstrike/ui';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import type {
  WorkspaceSearchChild,
  WorkspaceSearchFileResult,
  WorkspaceSearchResults,
} from '../core/search-result-model';

/**
 * Row payload for the workspace-search results tree. `compositeKey` is the
 * file-selection key (root-scoped) used by the selection bridge; it is only
 * ever null for defensive typing — files whose root is unmounted are omitted
 * entirely rather than rendered non-actionable, so emitted rows always carry a
 * real key.
 */
export type SearchNodeData =
  | { kind: 'file'; file: WorkspaceSearchFileResult; compositeKey: string | null }
  | {
      kind: 'child';
      child: WorkspaceSearchChild;
      compositeKey: string | null;
      filePath: string;
    };

/** Stable file row id (matches the store's expandedIds convention). */
export function fileNodeId(file: Pick<WorkspaceSearchFileResult, 'dbRootId' | 'path'>): string {
  return `f:${file.dbRootId}:${file.path}`;
}

/**
 * Stable child row id: `m:${chunkId}:${line}` for a text match (line
 * disambiguates multiple matches inside one chunk) or `m:${chunkId}` for a
 * whole-chunk semantic hit.
 */
export function childNodeId(child: WorkspaceSearchChild): string {
  return child.kind === 'match' ? `m:${child.chunkId}:${child.line}` : `m:${child.chunkId}`;
}

/**
 * Flattens results into the PRE-FLATTENED visible row model TreeTable consumes
 * (`nodesArePreFlattened`). Respects `expandedIds`: a collapsed file emits only
 * its own row, an expanded file emits its row followed by depth-1 child rows.
 * Files whose `resolveAdapterRootId(dbRootId)` returns null (root not mounted)
 * are omitted along with all their children.
 */
export function buildSearchTreeNodes(args: {
  results: WorkspaceSearchResults;
  expandedIds: ReadonlySet<string>;
  resolveAdapterRootId: (dbRootId: string) => string | null;
}): TreeNode<SearchNodeData>[] {
  const { results, expandedIds, resolveAdapterRootId } = args;
  const rows: TreeNode<SearchNodeData>[] = [];

  for (const file of results.files) {
    const adapterRootId = resolveAdapterRootId(file.dbRootId);
    if (adapterRootId === null) {
      continue;
    }
    const compositeKey = encodeFileSelection(adapterRootId, file.path);
    const id = fileNodeId(file);

    rows.push({
      childCount: file.children.length,
      data: { compositeKey, file, kind: 'file' },
      depth: 0,
      hasChildren: file.children.length > 0,
      id,
      parentId: null,
      type: 'file',
    });

    if (!expandedIds.has(id)) {
      continue;
    }

    for (const child of file.children) {
      rows.push({
        data: { child, compositeKey, filePath: file.path, kind: 'child' },
        depth: 1,
        hasChildren: false,
        id: childNodeId(child),
        parentId: id,
        type: 'child',
      });
    }
  }

  return rows;
}
