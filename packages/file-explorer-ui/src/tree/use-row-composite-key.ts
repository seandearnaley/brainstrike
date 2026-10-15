/**
 * A tree row's selection key, shared by the metadata cells (BST-1208) and the
 * "This thread" cell (ADR-0021).
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useMemo } from 'react';
import { reportUnidentifiedRow } from './file-tree-metadata-diagnostics';
import { useFileTreeSelection } from './file-tree-selection-context';
import type { FileTreeRowData } from './optimized-file-tree-model';

/**
 * Composite key for a row. Prefers the node's OWN root identity — in forest
 * mode a row can belong to a different root than the tree's fallback folderId,
 * and a key built from the wrong root would read another workspace's metadata.
 *
 * Returns null ONLY when the row cannot be identified at all, which the cells
 * surface as an explicit error rather than an empty cell.
 */
export function useRowCompositeKey(rowData: FileTreeRowData): string | null {
  const { folderId: fallbackFolderId } = useFileTreeSelection();
  const { path, rootFolderId } = rowData.fileNode;
  return useMemo(() => {
    const folderId = rootFolderId || fallbackFolderId;
    if (!(folderId && path)) {
      reportUnidentifiedRow(path);
      return null;
    }
    try {
      return encodeFileSelection(folderId, path);
    } catch (error) {
      // encodeFileSelection rejects paths it cannot round-trip. Catching here
      // is what stops a malformed key from ever reaching the store.
      reportUnidentifiedRow(path, error);
      return null;
    }
  }, [fallbackFolderId, path, rootFolderId]);
}
