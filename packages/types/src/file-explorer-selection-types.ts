/**
 * File Explorer Selection Types
 *
 * Selection-model types for the file explorer store (explicit + query-backed
 * selection) and their serialized/persisted counterparts.
 */

/**
 * Selection mode determines how files are selected.
 * - 'explicit': Traditional manual file selection (Set of composite keys)
 * - 'query': Query-backed recursive selection for large folder/root selections
 */
export type SelectionMode = 'explicit' | 'query';

export interface SelectionQueryDescriptor {
  coveredDirectoryPaths: string[];
  excludedPaths: string[];
  excludeFilters: string[];
  /**
   * RootId UUID (since storage v5); never a path.
   * This is the durable identity of the root — use it for composite keys,
   * folderStates lookups, and equality checks. It does NOT change when a
   * root directory is re-added after being disconnected.
   */
  folderId: string;
  includedPaths: string[];
  includeFilters: string[];
  kind: 'recursive-folder' | 'recursive-select-all';
  manifestFingerprint: string | null;
  manifestSnapshotId: string | null;
  /**
   * Absolute root path for query scoping/display — NOT identity.
   * Used by recursive-selection-query to scope file enumeration and
   * by the UI to display the folder name. Do NOT use for equality or
   * composite-key construction; use `folderId` (the RootId) for identity.
   */
  rootPath: string | null;
  totalSelectedCount: number;
  useRegex: boolean;
}

export interface QuerySelectionManifest {
  directoryCounts: Map<string, number>;
  errorMessage: string | null;
  filePaths: string[];
  fingerprint: string | null;
  pathSet: Set<string>;
  snapshotId: string | null;
  status: 'error' | 'loading' | 'ready';
}

/**
 * Selection model that supports explicit and query-backed selection.
 */
export interface SelectionModel {
  /**
   * Explicit selection paths (composite keys: folderId|@|path).
   * Used when mode is 'explicit'.
   */
  explicitPaths: Set<string>;

  /**
   * Timestamp of last materialization (for cache invalidation).
   */
  materializedAt: string | null;

  /**
   * Cached materialized paths for query selections (for display without
   * re-resolution). These are relative paths, not composite keys.
   */
  materializedPaths: Set<string> | null;
  /** Current selection mode */
  mode: SelectionMode;

  /**
   * Query descriptor for large recursive selections.
   * Only used when mode is 'query'.
   */
  queryDescriptor: SelectionQueryDescriptor | null;
}

/**
 * Serialized version of SelectionModel for persistence.
 */
export interface SerializedSelectionModel {
  explicitPaths: string[];
  materializedAt: string | null;
  materializedPaths: string[] | null;
  mode: SelectionMode;
  queryDescriptor: SelectionQueryDescriptor | null;
}

/**
 * Create an empty selection model with explicit mode.
 */
export function createEmptySelectionModel(): SelectionModel {
  return {
    explicitPaths: new Set(),
    materializedAt: null,
    materializedPaths: null,
    mode: 'explicit',
    queryDescriptor: null,
  };
}
