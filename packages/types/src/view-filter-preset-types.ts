/**
 * View Filter Preset Types
 *
 * Types for the preset-based file filtering system that replaces
 * the previous include/exclude pattern fields.
 */

// ============================================================================
// Icon Types
// ============================================================================

/**
 * Supported Lucide icon names for view filter presets.
 * These map to actual Lucide React icon components.
 */
export type ViewFilterPresetIcon =
  | 'file'
  | 'file-code'
  | 'file-text'
  | 'folder'
  | 'folder-open'
  | 'code'
  | 'settings'
  | 'database'
  | 'box'
  | 'user'
  | 'layout'
  | 'globe'
  | 'cpu'
  | 'palette'
  | 'flask-conical'
  | 'test-tube';

/**
 * Icon metadata for display in the icon picker.
 */
export interface IconOption {
  /** Lucide icon name */
  name: ViewFilterPresetIcon;
  /** Human-readable label */
  label: string;
}

/**
 * Default icon options available in the preset editor.
 */
export const PRESET_ICON_OPTIONS: readonly IconOption[] = [
  { name: 'file', label: 'Default' },
  { name: 'file-code', label: 'Code' },
  { name: 'file-text', label: 'Text' },
  { name: 'database', label: 'Data' },
  { name: 'settings', label: 'Config' },
  { name: 'box', label: 'Module' },
  { name: 'folder-open', label: 'Folder' },
  { name: 'palette', label: 'Style' },
  { name: 'flask-conical', label: 'Test' },
  { name: 'globe', label: 'Web' },
] as const;

// ============================================================================
// Preset Types
// ============================================================================

/**
 * A view filter preset defines include/exclude patterns for file filtering.
 * This replaces the previous separate includeFilters/excludeFilters/useRegex fields.
 */
export interface ViewFilterPreset {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Optional description */
  description: string | null;
  /** Lucide icon name */
  icon: ViewFilterPresetIcon;
  /** Include patterns (glob or regex based on useRegex) */
  includes: string[];
  /** Exclude patterns (glob or regex based on useRegex) */
  excludes: string[];
  /** Whether patterns are regex (true) or glob (false) */
  useRegex: boolean;
  /** Whether this is a built-in default preset (cannot be deleted) */
  isDefault: boolean;
  /** Sort order for display */
  sortOrder: number;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Data required to create a new preset.
 */
export interface CreateViewFilterPresetInput {
  name: string;
  description?: string;
  icon?: ViewFilterPresetIcon;
  includes: string[];
  excludes: string[];
  useRegex?: boolean;
}

/**
 * Data for updating an existing preset.
 */
export interface UpdateViewFilterPresetInput {
  name?: string;
  description?: string | null;
  icon?: ViewFilterPresetIcon;
  includes?: string[];
  excludes?: string[];
  useRegex?: boolean;
  sortOrder?: number;
}

// ============================================================================
// State Types
// ============================================================================

/**
 * View filter state stored per folder.
 * Replaces the previous includeFilters/excludeFilters/useRegex in FolderState.
 */
export interface ViewFilterState {
  /** Currently selected preset ID (null = no filtering) */
  selectedPresetId: string | null;
}

/**
 * Serialized view filter state for persistence.
 */
export interface SerializedViewFilterState {
  selectedPresetId: string | null;
}

/**
 * Default view filter state.
 */
export const DEFAULT_VIEW_FILTER_STATE: ViewFilterState = {
  selectedPresetId: null,
};

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Result of applying a preset's patterns to a file path.
 */
export interface PatternMatchResult {
  /** Whether the file should be included (visible) */
  included: boolean;
  /** The pattern that matched (for debugging) */
  matchedPattern: string | null;
  /** Whether the match was from an include or exclude pattern */
  matchType: 'include' | 'exclude' | null;
}

/**
 * Helper to get patterns from a preset.
 */
export function getPresetIncludes(preset: ViewFilterPreset): string[] {
  return preset.includes;
}

/**
 * Helper to get exclude patterns from a preset.
 */
export function getPresetExcludes(preset: ViewFilterPreset): string[] {
  return preset.excludes;
}
