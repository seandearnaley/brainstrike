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
  /** File or directory name */
  name: string;
  /** Full path (also used as handleKey for handle lookup) */
  path: string;
  /** Node type */
  type: 'file' | 'directory';
  /** Nesting depth from root */
  depth: number;
  /** Root folder identifier */
  rootFolderId: string;
  /** Load state for directories */
  loadState?: DirectoryLoadState;
  /** Error message if load failed */
  loadError?: string;
  /** Children (for directories) */
  children?: WorkerFileNode[];
  /** File size in bytes (for files) */
  size?: number;
  /** Last modification time (for files) */
  lastModified?: number;
}

// ============================================================================
// Messages: Main Thread -> Worker
// ============================================================================

/**
 * Initialize the worker with root-level nodes.
 */
export interface InitMessage {
  type: 'init';
  payload: {
    rootNodes: WorkerFileNode[];
    folderId: string;
  };
}

/**
 * Result of loading a directory from the main thread.
 */
export interface LoadResultMessage {
  type: 'loadResult';
  payload: {
    path: string;
    children: WorkerFileNode[];
  };
}

/**
 * Result of a failed directory load.
 */
export interface LoadErrorMessage {
  type: 'loadError';
  payload: {
    path: string;
    error: string;
  };
}

/**
 * Start expand-all operation.
 */
export interface ExpandAllMessage {
  type: 'expandAll';
  payload: {
    folderId: string;
  };
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
  type: 'toggleExpand';
  payload: {
    path: string;
  };
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
  type: 'loadPaths';
  payload: {
    /** Directory paths to load (should be sorted by depth, shallowest first) */
    paths: string[];
  };
}

/**
 * Load all descendants of a specific directory (for recursive folder selection).
 * Like expandAll but scoped to a subtree starting from the given path.
 */
export interface LoadSubtreeMessage {
  type: 'loadSubtree';
  payload: {
    /** Root path of the subtree to load */
    startPath: string;
  };
}

/**
 * Update the tree with new nodes (e.g., after single directory load).
 */
export interface UpdateTreeMessage {
  type: 'updateTree';
  payload: {
    path: string;
    children: WorkerFileNode[];
    loadState: DirectoryLoadState;
  };
}

/**
 * Request worker to flatten the tree for virtualized rendering.
 * The worker computes the flattened list based on its current tree state
 * and the set of expanded paths.
 */
export interface FlattenTreeMessage {
  type: 'flattenTree';
  payload: {
    /** Paths that should be considered expanded (from UI state) */
    expandedPaths: string[];
  };
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
  type: 'requestLoad';
  payload: {
    /** Request ID for correlation */
    requestId: string;
    /** Directory paths to load */
    paths: string[];
  };
}

/**
 * Updated tree snapshot for React state sync.
 */
export interface TreeSnapshotMessage {
  type: 'treeSnapshot';
  payload: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
  };
}

/**
 * Progress update during expand-all.
 */
export interface ProgressMessage {
  type: 'progress';
  payload: {
    loaded: number;
    total: number;
    currentPath: string;
  };
}

/**
 * Expand-all operation completed.
 */
export interface CompleteMessage {
  type: 'complete';
  payload: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
    /** Number of directories actually loaded (0 means all were cached) */
    loadedCount: number;
  };
}

/**
 * Error occurred in worker.
 */
export interface ErrorMessage {
  type: 'error';
  payload: {
    message: string;
    path?: string;
  };
}

/**
 * Log message from worker for debugging.
 */
export interface WorkerLogMessage {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

/**
 * A node in the flattened list for virtualized rendering.
 * Contains the node data plus computed depth for indentation.
 */
export interface FlattenedNode {
  /** The node data */
  node: WorkerFileNode;
  /** Nesting depth (0 = root level) */
  depth: number;
}

/**
 * Result of flattening the tree.
 * Sent in response to FlattenTreeMessage.
 */
export interface FlattenedResultMessage {
  type: 'flattenedResult';
  payload: {
    /** Flattened list of visible nodes for virtualized rendering */
    nodes: FlattenedNode[];
    /** Total count of nodes in the list */
    count: number;
    /** Duration of the flatten operation in ms (for perf monitoring) */
    durationMs: number;
  };
}

/**
 * All possible messages from worker to main thread.
 */
export type WorkerToMainMessage =
  | WorkerReadyMessage
  | RequestLoadMessage
  | TreeSnapshotMessage
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
  path: string;
  children?: WorkerFileNode[];
  error?: string;
}
