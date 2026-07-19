import type { FileExplorerState } from '@brainstrike/types';
import {
  computeNodeSelectionState,
  type DirectorySelectionTraversalContext,
  type FileTreeRowData,
  type NodeSelectionState,
} from './optimized-file-tree-model';

/**
 * Everything `computeNodeSelectionState` needs that can change as the user
 * selects — funneled through an external store so each tree cell can subscribe
 * to ONLY its own derived state (via useSyncExternalStore) instead of reading a
 * whole-tree selection context that changes identity on every toggle and
 * re-renders every visible cell. See #1594.
 */
export interface FileTreeSelectionInputs {
  directoryTraversalContext: DirectorySelectionTraversalContext;
  folderId: string;
  maxSelectionCount: number;
  querySelectionManifest: FileExplorerState['querySelectionManifest'];
  selectedCount: number;
  selectedDirectoryCounts: Map<string, number>;
  selectedFilePaths: Set<string>;
  selectionModel: FileExplorerState['selectionModel'];
}

/**
 * Everything a cell renders that is SELECTION-DERIVED — the checkbox tri-state
 * and whether adding would exceed the cap. Deriving this here (rather than
 * letting the cell read `selectionModel`) keeps the cell off any input whose
 * identity changes per toggle.
 */
export type FileTreeNodeCellState = NodeSelectionState;

export interface FileTreeSelectionStore {
  /**
   * Per-node derived cell state, cached so the returned object keeps a STABLE
   * identity while the node's state is unchanged — this is what lets
   * useSyncExternalStore skip re-rendering unaffected cells AND, conversely,
   * guarantees a re-render the moment the state actually changes.
   */
  getNodeState: (rowData: FileTreeRowData) => FileTreeNodeCellState;
  /** Fire subscribers. Call from an effect, never during render. */
  notify: () => void;
  /**
   * Replace the current inputs. Render-safe (a pure write, no listener calls) —
   * mirrors the PreviewTable HeaderSelectionStore pattern.
   */
  setInputs: (inputs: FileTreeSelectionInputs) => void;
  subscribe: (listener: () => void) => () => void;
}

function nodeStateEquals(a: FileTreeNodeCellState, b: FileTreeNodeCellState): boolean {
  return a.checkboxState === b.checkboxState && a.wouldExceedLimit === b.wouldExceedLimit;
}

export function createFileTreeSelectionStore(
  initialInputs: FileTreeSelectionInputs
): FileTreeSelectionStore {
  let inputs = initialInputs;
  const listeners = new Set<() => void>();
  // Per-path cache of the last returned cell state. Keeping the same object
  // reference when the value is unchanged is the entire point (see getNodeState
  // docs). Keyed by node path; bounded by the tree size.
  const nodeStateCache = new Map<string, FileTreeNodeCellState>();

  return {
    getNodeState: (rowData) => {
      const selectionState = computeNodeSelectionState(
        rowData,
        inputs.directoryTraversalContext,
        inputs.folderId,
        inputs.querySelectionManifest,
        inputs.selectionModel,
        inputs.selectedFilePaths,
        inputs.selectedDirectoryCounts,
        inputs.selectedCount,
        inputs.maxSelectionCount
      );
      const computed: FileTreeNodeCellState = { ...selectionState };
      const key = rowData.fileNode.path;
      const cached = nodeStateCache.get(key);
      if (cached && nodeStateEquals(cached, computed)) {
        return cached;
      }
      nodeStateCache.set(key, computed);
      return computed;
    },
    notify: () => {
      // Copy before iterating: a listener may synchronously unmount a sibling
      // subscriber, mutating the Set mid-loop (Zustand/Redux-internals pattern).
      for (const listener of [...listeners]) {
        listener();
      }
    },
    setInputs: (next) => {
      // The per-path cache is keyed by node path, which is only unique WITHIN a
      // root/folder. When the folder changes the whole tree changes, so evict
      // stale entries to keep the cache bounded by ONE folder's node count
      // instead of every path ever rendered across folder switches.
      if (next.folderId !== inputs.folderId) {
        nodeStateCache.clear();
      }
      inputs = next;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
