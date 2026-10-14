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
  /** Human-readable label */
  label: string;
  /** Lucide icon name */
  name: ViewFilterPresetIcon;
}

/**
 * Default icon options available in the preset editor.
 */
export const PRESET_ICON_OPTIONS: readonly IconOption[] = [
  { label: 'Default', name: 'file' },
  { label: 'Code', name: 'file-code' },
  { label: 'Text', name: 'file-text' },
  { label: 'Data', name: 'database' },
  { label: 'Config', name: 'settings' },
  { label: 'Module', name: 'box' },
  { label: 'Folder', name: 'folder-open' },
  { label: 'Style', name: 'palette' },
  { label: 'Test', name: 'flask-conical' },
  { label: 'Web', name: 'globe' },
] as const;

// ============================================================================
// Preset Types
// ============================================================================

/**
 * A view filter preset defines include/exclude patterns for file filtering.
 * This replaces the previous separate includeFilters/excludeFilters/useRegex fields.
 */
export interface ViewFilterPreset {
  /** Creation timestamp */
  createdAt: Date;
  /** Optional description */
  description: string | null;
  /** Exclude patterns (glob or regex based on useRegex) */
  excludes: string[];
  /** Lucide icon name */
  icon: ViewFilterPresetIcon;
  /** Unique identifier */
  id: string;
  /** Include patterns (glob or regex based on useRegex) */
  includes: string[];
  /** Whether this is a built-in default preset (cannot be deleted) */
  isDefault: boolean;
  /** Display name */
  name: string;
  /** Sort order for display */
  sortOrder: number;
  /** Last update timestamp */
  updatedAt: Date;
  /** Whether patterns are regex (true) or glob (false) */
  useRegex: boolean;
}

/**
 * Data required to create a new preset.
 */
export interface CreateViewFilterPresetInput {
  description?: string;
  excludes: string[];
  icon?: ViewFilterPresetIcon;
  includes: string[];
  name: string;
  useRegex?: boolean;
}

/**
 * Data for updating an existing preset.
 */
export interface UpdateViewFilterPresetInput {
  description?: string | null;
  excludes?: string[];
  icon?: ViewFilterPresetIcon;
  includes?: string[];
  name?: string;
  sortOrder?: number;
  useRegex?: boolean;
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

/** Canonical fresh-profile defaults shared by native and browser persistence. */
export const DEFAULT_VIEW_FILTER_PRESETS = [
  {
    description: 'Source files for TypeScript and JavaScript projects',
    excludes: ['node_modules', 'dist', 'build', '.next', 'coverage', '*.test.*', '*.spec.*'],
    icon: 'file-code',
    includes: ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'],
    isDefault: true,
    name: 'TypeScript/JavaScript',
    sortOrder: 1,
    useRegex: false,
  },
  {
    description: 'All programming language source files',
    excludes: ['node_modules', 'dist', 'build', 'target', '__pycache__', '.git', 'vendor'],
    icon: 'code',
    includes: [
      '*.ts',
      '*.tsx',
      '*.js',
      '*.jsx',
      '*.py',
      '*.rs',
      '*.go',
      '*.java',
      '*.c',
      '*.cpp',
      '*.h',
      '*.hpp',
      '*.cs',
      '*.rb',
      '*.php',
      '*.swift',
      '*.kt',
    ],
    isDefault: true,
    name: 'All Code',
    sortOrder: 2,
    useRegex: false,
  },
  {
    description: 'Markdown and documentation files',
    excludes: ['node_modules', '.git'],
    icon: 'file-text',
    includes: ['*.md', '*.mdx', '*.txt', '*.rst', 'README*', 'LICENSE*', 'CHANGELOG*'],
    isDefault: true,
    name: 'Documentation',
    sortOrder: 3,
    useRegex: false,
  },
  {
    description: 'Configuration and environment files',
    excludes: ['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    icon: 'settings',
    includes: [
      '*.json',
      '*.yaml',
      '*.yml',
      '*.toml',
      '*.ini',
      '*.env*',
      '*.config.*',
      'tsconfig*',
      'package.json',
      'Cargo.toml',
    ],
    isDefault: true,
    name: 'Config Files',
    sortOrder: 4,
    useRegex: false,
  },
  {
    description: 'CSS and styling files',
    excludes: ['node_modules', 'dist'],
    icon: 'palette',
    includes: ['*.css', '*.scss', '*.sass', '*.less', '*.styl', '*.styled.*'],
    isDefault: true,
    name: 'Styles',
    sortOrder: 5,
    useRegex: false,
  },
  {
    description: 'Test files only',
    excludes: ['node_modules', 'coverage'],
    icon: 'flask-conical',
    includes: ['*.test.*', '*.spec.*', '**/__tests__/**', '**/tests/**', '**/test/**'],
    isDefault: true,
    name: 'Tests',
    sortOrder: 6,
    useRegex: false,
  },
  {
    description: 'Show all files without filtering',
    excludes: ['node_modules', '.git', 'dist', 'build'],
    icon: 'folder-open',
    includes: ['*'],
    isDefault: true,
    name: 'All Files',
    sortOrder: 7,
    useRegex: false,
  },
] satisfies readonly Omit<ViewFilterPreset, 'id' | 'createdAt' | 'updatedAt'>[];

export type ViewFilterPresetRecord = Omit<ViewFilterPreset, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};
export type ViewFilterPresetRequest =
  | { operation: 'list' }
  | { operation: 'create'; input: CreateViewFilterPresetInput }
  | { operation: 'update'; id: string; input: UpdateViewFilterPresetInput }
  | { operation: 'delete'; id: string };
export interface ViewFilterPresetReply {
  deleted?: boolean;
  presets: ViewFilterPresetRecord[];
}
export interface ViewFilterPresetCapability {
  request(input: ViewFilterPresetRequest): Promise<ViewFilterPresetReply>;
}
