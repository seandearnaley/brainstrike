/**
 * STABLE per-tree context (#1594), extracted from `optimized-file-tree.tsx`
 * when the tree became a grid (BST-1208) and its cells moved to sibling
 * modules.
 *
 * Holds only fields that do NOT change on a selection toggle — so a cell
 * reading this context does not re-render per toggle. All selection-DERIVED
 * state (checkbox tri-state, wouldExceedLimit, rule marker) is read from
 * `store` via useSyncExternalStore per node, which re-renders ONLY the cells
 * whose own state changed. (An earlier attempt that put selection state
 * directly in the context re-rendered every visible cell per toggle — the exact
 * cost this split removes.)
 */

import { createContext, useContext } from 'react';
import type { FileTreeSelectionStore } from './optimized-file-tree-selection-store';

export interface FileTreeSelectionContextValue {
  folderId: string;
  isDirectorySelectionLocked: boolean;
  maxSelectionCount: number;
  /**
   * Opens a file as a workspace tab. Hoisted into the shared context so each
   * virtualized row reuses the parent's single useIdeFileEditor subscription
   * instead of paying for one per visible row.
   */
  openFileInTab: ((compositeKey: string) => void) | undefined;
  store: FileTreeSelectionStore;
}

export const FileTreeSelectionContext = createContext<FileTreeSelectionContextValue | null>(null);

export function useFileTreeSelection(): FileTreeSelectionContextValue {
  const context = useContext(FileTreeSelectionContext);
  if (!context) {
    throw new Error('useFileTreeSelection must be used within FileTreeSelectionContext');
  }
  return context;
}
