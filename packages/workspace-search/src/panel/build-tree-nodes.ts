import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { TreeNode } from '@brainstrike/ui';
import type { WorkspaceSearchFileResult, WorkspaceSearchMatch } from '../core/search-result-model';
import { fileResultId } from '../core/workspace-search-store';

/**
 * Row payload for the results tree: a file, then its matching lines.
 * `compositeKey` is the file-selection key the selection bridge and the
 * file-open seam use.
 */
export type SearchNodeData =
  | { compositeKey: string; file: WorkspaceSearchFileResult; kind: 'file' }
  | { compositeKey: string; filePath: string; kind: 'match'; match: WorkspaceSearchMatch };

/** A match row's id: unique per file and line. */
export function matchNodeId(fileId: string, line: number): string {
  return `m:${fileId}:${line}`;
}

/**
 * Flattens results into the PRE-FLATTENED visible row model TreeTable consumes
 * (`nodesArePreFlattened`): every file row, followed by its match rows unless
 * the user collapsed it.
 */
export function buildSearchTreeNodes(args: {
  collapsedIds: ReadonlySet<string>;
  files: readonly WorkspaceSearchFileResult[];
}): TreeNode<SearchNodeData>[] {
  const rows: TreeNode<SearchNodeData>[] = [];
  for (const file of args.files) {
    const id = fileResultId(file);
    const compositeKey = encodeFileSelection(file.rootId, file.path);
    rows.push({
      childCount: file.matches.length,
      data: { compositeKey, file, kind: 'file' },
      depth: 0,
      hasChildren: file.matches.length > 0,
      id,
      parentId: null,
      type: 'file',
    });
    if (args.collapsedIds.has(id)) {
      continue;
    }
    for (const match of file.matches) {
      rows.push({
        data: { compositeKey, filePath: file.path, kind: 'match', match },
        depth: 1,
        hasChildren: false,
        id: matchNodeId(id, match.line),
        parentId: id,
        type: 'match',
      });
    }
  }
  return rows;
}
