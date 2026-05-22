/**
 * File Tree Worker Types
 *
 * Defines the message protocol for communication between the main thread
 * and the file tree worker. The key constraint is that FileSystemHandle
 * objects cannot be transferred to workers, so we use path-based keys
 * for handle lookup on the main thread.
 */

/**
 * Load state for a directory node.
 */
export type DirectoryLoadState = 'unloaded' | 'loading' | 'loaded' | 'error';

/**
 * Node type without FileSystemHandle - safe for worker transfer.
 * Uses handleKey (the path) for main thread handle lookup.
 */
export interface WorkerFileNode {
  /** Children (for directories) */
  children?: WorkerFileNode[];
  /** Nesting depth from root */
  depth: number;
  /** Last modification time (for files) */
  lastModified?: number;
  /** Error message if load failed */
  loadError?: string;
  /** Load state for directories */
  loadState?: DirectoryLoadState;
  /** File or directory name */
  name: string;
  /** Full path (also used as handleKey for handle lookup) */
  path: string;
  /** Root folder identifier */
  rootFolderId: string;
  /** File size in bytes (for files) */
  size?: number;
  /** Node type */
  type: 'file' | 'directory';
}

// ============================================================================
// Messages: Main Thread -> Worker
// ============================================================================

/**
 * Initialize the worker with root-level nodes.
 */
export interface InitMessage {
  payload: {
    rootNodes: WorkerFileNode[];
    folderId: string;
  };
  type: 'init';
}

/**
 * Result of loading a directory from the main thread.
 */
export interface LoadResultMessage {
  payload: {
    path: string;
    children: WorkerFileNode[];
  };
  type: 'loadResult';
}

/**
 * Result of a failed directory load.
 */
export interface LoadErrorMessage {
  payload: {
    path: string;
    error: string;
  };
  type: 'loadError';
}

/**
 * Start expand-all operation.
 */
export interface ExpandAllMessage {
  payload: {
    folderId: string;
  };
  type: 'expandAll';
}

/**
 * Collapse all directories.
 */
export interface CollapseAllMessage {
  type: 'collapseAll';
}

/**
 * Toggle expansion of a single directory.
 */
export interface ToggleExpandMessage {
  payload: {
    path: string;
  };
  type: 'toggleExpand';
}

/**
 * Abort current operation.
 */
export interface AbortMessage {
  type: 'abort';
}

/**
 * Load specific paths (for restoring expanded directories).
 * Unlike expandAll which does BFS discovery, this loads only the requested paths.
 */
export interface LoadPathsMessage {
  payload: {
    /** Directory paths to load (should be sorted by depth, shallowest first) */
    paths: string[];
  };
  type: 'loadPaths';
}

/**
 * Load all descendants of a specific directory (for recursive folder selection).
 * Like expandAll but scoped to a subtree starting from the given path.
 */
export interface LoadSubtreeMessage {
  payload: {
    /** Root path of the subtree to load */
    startPath: string;
  };
  type: 'loadSubtree';
}

/**
 * Update the tree with new nodes (e.g., after single directory load).
 */
export interface UpdateTreeMessage {
  payload: {
    path: string;
    children: WorkerFileNode[];
    loadState: DirectoryLoadState;
  };
  type: 'updateTree';
}

/**
 * Request worker to flatten the tree for virtualized rendering.
 * The worker computes the flattened list based on its current tree state
 * and the set of expanded paths.
 */
export interface FlattenTreeMessage {
  payload: {
    /** Paths that should be considered expanded (from UI state) */
    expandedPaths: string[];
  };
  type: 'flattenTree';
}

/**
 * All possible messages from main thread to worker.
 */
export type MainToWorkerMessage =
  | InitMessage
  | LoadResultMessage
  | LoadErrorMessage
  | ExpandAllMessage
  | CollapseAllMessage
  | ToggleExpandMessage
  | AbortMessage
  | LoadPathsMessage
  | LoadSubtreeMessage
  | UpdateTreeMessage
  | FlattenTreeMessage;

// ============================================================================
// Messages: Worker -> Main Thread
// ============================================================================

/**
 * Worker is ready to receive messages.
 */
export interface WorkerReadyMessage {
  type: 'ready';
}

/**
 * Request main thread to load directories (I/O needs FileSystemHandle).
 */
export interface RequestLoadMessage {
  payload: {
    /** Request ID for correlation */
    requestId: string;
    /** Directory paths to load */
    paths: string[];
  };
  type: 'requestLoad';
}

/**
 * Updated tree snapshot for React state sync.
 */
export interface TreeSnapshotMessage {
  payload: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
  };
  type: 'treeSnapshot';
}

/**
 * Patch for a directory whose children were loaded or replaced.
 */
export interface ChildrenLoadedPatchMessage {
  payload: {
    path: string;
    children: WorkerFileNode[];
    loadState: Extract<DirectoryLoadState, 'loaded'>;
  };
  type: 'childrenLoaded';
}

/**
 * Patch for a directory load-state transition.
 */
export interface NodeLoadStateChangedPatchMessage {
  payload: {
    path: string;
    loadState: DirectoryLoadState;
    loadError?: string;
  };
  type: 'nodeLoadStateChanged';
}

/**
 * Patch for expanded-path membership changes.
 */
export interface ExpandedPathsDeltaMessage {
  payload: {
    added: string[];
    removed: string[];
  };
  type: 'expandedPathsDelta';
}

/**
 * Progress update during expand-all.
 */
export interface ProgressMessage {
  payload: {
    loaded: number;
    total: number;
    currentPath: string;
  };
  type: 'progress';
}

/**
 * Expand-all operation completed.
 */
export interface CompleteMessage {
  payload: {
    expandedPaths: string[];
    /** Number of directories actually loaded (0 means all were cached) */
    loadedCount: number;
  };
  type: 'complete';
}

/**
 * Error occurred in worker.
 */
export interface ErrorMessage {
  payload: {
    message: string;
    path?: string;
  };
  type: 'error';
}

/**
 * Log message from worker for debugging.
 */
export interface WorkerLogMessage {
  data?: Record<string, unknown>;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  type: 'log';
}

/**
 * A node in the flattened list for virtualized rendering.
 * Contains the node data plus computed depth for indentation.
 */
export interface FlattenedNode {
  /** Nesting depth (0 = root level) */
  depth: number;
  /** The node data */
  node: WorkerFileNode;
}

/**
 * Result of flattening the tree.
 * Sent in response to FlattenTreeMessage.
 */
export interface FlattenedResultMessage {
  payload: {
    /** Flattened list of visible nodes for virtualized rendering */
    nodes: FlattenedNode[];
    /** Total count of nodes in the list */
    count: number;
    /** Duration of the flatten operation in ms (for perf monitoring) */
    durationMs: number;
  };
  type: 'flattenedRows';
}

export type FileTreePatchMessage =
  | ChildrenLoadedPatchMessage
  | NodeLoadStateChangedPatchMessage
  | ExpandedPathsDeltaMessage;

/**
 * All possible messages from worker to main thread.
 */
export type WorkerToMainMessage =
  | WorkerReadyMessage
  | RequestLoadMessage
  | TreeSnapshotMessage
  | ChildrenLoadedPatchMessage
  | NodeLoadStateChangedPatchMessage
  | ExpandedPathsDeltaMessage
  | ProgressMessage
  | CompleteMessage
  | ErrorMessage
  | WorkerLogMessage
  | FlattenedResultMessage;

// ============================================================================
// Batch Load Types (for coordinating main thread I/O)
// ============================================================================

/**
 * Result of loading a single directory.
 */
export interface BatchLoadResult {
  children?: WorkerFileNode[];
  error?: string;
  path: string;
}
