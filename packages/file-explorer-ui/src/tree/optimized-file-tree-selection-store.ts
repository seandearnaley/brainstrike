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
 * Everything a cell renders that is SELECTION-DERIVED — the checkbox tri-state,
 * whether adding would exceed the cap, and the rules-mode "selected by rule"
 * marker. Folding `isRuleSelected` in here (rather than letting the cell read
 * `selectionModel`) keeps the cell off any input whose identity changes per
 * toggle.
 */
export interface FileTreeNodeCellState extends NodeSelectionState {
  isRuleSelected: boolean;
}

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
  return (
    a.checkboxState === b.checkboxState &&
    a.wouldExceedLimit === b.wouldExceedLimit &&
    a.isRuleSelected === b.isRuleSelected
  );
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
      const isRuleSelected =
        rowData.fileNode.type === 'file' &&
        inputs.selectionModel.mode === 'rules' &&
        (inputs.selectionModel.materializedPaths?.has(rowData.fileNode.path) ?? false);
      const computed: FileTreeNodeCellState = { ...selectionState, isRuleSelected };
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
