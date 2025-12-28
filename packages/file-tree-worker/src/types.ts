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
export type WorkerFileNode = {
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
};

// ============================================================================
// Messages: Main Thread -> Worker
// ============================================================================

/**
 * Initialize the worker with root-level nodes.
 */
export type InitMessage = {
  type: 'init';
  payload: {
    rootNodes: WorkerFileNode[];
    folderId: string;
  };
};

/**
 * Result of loading a directory from the main thread.
 */
export type LoadResultMessage = {
  type: 'loadResult';
  payload: {
    path: string;
    children: WorkerFileNode[];
  };
};

/**
 * Result of a failed directory load.
 */
export type LoadErrorMessage = {
  type: 'loadError';
  payload: {
    path: string;
    error: string;
  };
};

/**
 * Start expand-all operation.
 */
export type ExpandAllMessage = {
  type: 'expandAll';
  payload: {
    folderId: string;
  };
};

/**
 * Collapse all directories.
 */
export type CollapseAllMessage = {
  type: 'collapseAll';
};

/**
 * Toggle expansion of a single directory.
 */
export type ToggleExpandMessage = {
  type: 'toggleExpand';
  payload: {
    path: string;
  };
};

/**
 * Abort current operation.
 */
export type AbortMessage = {
  type: 'abort';
};

/**
 * Update the tree with new nodes (e.g., after single directory load).
 */
export type UpdateTreeMessage = {
  type: 'updateTree';
  payload: {
    path: string;
    children: WorkerFileNode[];
    loadState: DirectoryLoadState;
  };
};

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
  | UpdateTreeMessage;

// ============================================================================
// Messages: Worker -> Main Thread
// ============================================================================

/**
 * Worker is ready to receive messages.
 */
export type WorkerReadyMessage = {
  type: 'ready';
};

/**
 * Request main thread to load directories (I/O needs FileSystemHandle).
 */
export type RequestLoadMessage = {
  type: 'requestLoad';
  payload: {
    /** Request ID for correlation */
    requestId: string;
    /** Directory paths to load */
    paths: string[];
  };
};

/**
 * Updated tree snapshot for React state sync.
 */
export type TreeSnapshotMessage = {
  type: 'treeSnapshot';
  payload: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
  };
};

/**
 * Progress update during expand-all.
 */
export type ProgressMessage = {
  type: 'progress';
  payload: {
    loaded: number;
    total: number;
    currentPath: string;
  };
};

/**
 * Expand-all operation completed.
 */
export type CompleteMessage = {
  type: 'complete';
  payload: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
  };
};

/**
 * Error occurred in worker.
 */
export type ErrorMessage = {
  type: 'error';
  payload: {
    message: string;
    path?: string;
  };
};

/**
 * Log message from worker for debugging.
 */
export type WorkerLogMessage = {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

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
  | WorkerLogMessage;

// ============================================================================
// Batch Load Types (for coordinating main thread I/O)
// ============================================================================

/**
 * Result of loading a single directory.
 */
export type BatchLoadResult = {
  path: string;
  children?: WorkerFileNode[];
  error?: string;
};
