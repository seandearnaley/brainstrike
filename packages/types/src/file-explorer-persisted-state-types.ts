/**
 * File Explorer Persisted State Types
 *
 * Serialized/persisted-state shapes for the file explorer store, plus the
 * live per-folder state shape (FolderState) that mirrors them.
 */

import type { SelectionModel, SerializedSelectionModel } from './file-explorer-selection-types.js';
import type { StoredRootDescriptor } from './file-explorer-state-types.js';

// Helper types for serialization
export interface SerializedFolderState {
  excludeFilters: string[];
  expandedDirectoryPaths: string[];
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  lastAccessed: number;
  lastActiveTab: string;
  maxSelectionCount: number;
  selectedFilePaths: string[];
  selectionModel?: SerializedSelectionModel;
  useRegex: boolean;
  /**
   * ID of the selected view filter preset.
   * When set, includes/excludes/useRegex are derived from the preset.
   * Optional for backward compatibility with existing persisted state.
   */
  viewFilterPresetId?: string | null;
}

export interface SerializedState {
  /**
   * Ordered list of active root IDs (sidebar order).
   * activeRootIds[0] is the MAIN root — the assistant's operating root
   * (declared client-side; see setMainRoot). Persisting the order persists
   * the main-root choice; no separate field exists.
   * Optional for backward compatibility — older snapshots lack this field.
   */
  activeRootIds?: string[];
  currentFolderId: string | null;
  devInlineFixtureEnabled: boolean;
  excludeFilters: string[];
  expandedDirectoryPaths: string[];
  /**
   * Vertical scroll offset (px) of the explorer's scroll container, so a
   * session resumes at the same position. Workspace-global (one scroll
   * container spans every forest section), mirroring expandedDirectoryPaths.
   * Optional for backward compatibility with older snapshots.
   */
  explorerScrollTop?: number;
  folderAccessOrder: string[];
  folderStates: Record<string, SerializedFolderState>;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  /**
   * Whether the filter chips row is visible inside the view filters section.
   * Optional for backward compatibility with existing persisted state.
   */
  isFilterChipsVisible?: boolean;
  /**
   * Whether the view filters section is expanded.
   * Optional for backward compatibility with existing persisted state.
   */
  isFiltersExpanded?: boolean;
  lastActiveTab: string;
  maxSelectionCount: number;
  quickFilter: string;
  /**
   * Map of rootId → StoredRootDescriptor for all active roots.
   * Optional for backward compatibility — older snapshots lack this field.
   */
  rootDescriptors?: Record<string, StoredRootDescriptor>;
  selectedFilePaths: string[];
  /**
   * Selection model for explicit/query selection.
   * Optional for backward compatibility with existing persisted state.
   */
  selectionModel?: SerializedSelectionModel;
  useRegex: boolean;
  /**
   * ID of the selected view filter preset.
   * When set, includes/excludes/useRegex are derived from the preset.
   * Optional for backward compatibility with existing persisted state.
   */
  viewFilterPresetId?: string | null;
}

export interface FolderState {
  excludeFilters: string[];
  expandedDirectoryPaths: Set<string>;
  /**
   * Number of files displayed before summarizing a folder in the generated
   * report's project tree. Does not affect the file explorer UI.
   */
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  lastAccessed: number;
  lastActiveTab: string;
  maxSelectionCount: number;
  selectedFilePaths: Set<string>;
  selectionModel: SelectionModel;
  useRegex: boolean;
  /**
   * ID of the selected view filter preset.
   * When set, includes/excludes/useRegex are derived from the preset.
   */
  viewFilterPresetId: string | null;
}
