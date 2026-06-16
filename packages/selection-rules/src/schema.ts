/**
 * Selection Rules Schema v1
 *
 * A versioned schema for rule-based file selection in BrainStrike.
 * Rules are evaluated in precedence order to produce a materialized selection.
 */

// ============================================================================
// Schema Version
// ============================================================================

/** Schema version for migration support */
export const SELECTION_RULES_SCHEMA_VERSION = 1 as const;

/** Type alias for the schema version literal */
export type SelectionRulesSchemaVersion = typeof SELECTION_RULES_SCHEMA_VERSION;

// ============================================================================
// Rule Types
// ============================================================================

/**
 * Rule types ordered by evaluation precedence (highest first during override phase).
 *
 * Evaluation order:
 * 1. root-include  → Start with directories
 * 2. glob-include  → Add pattern matches
 * 3. root-exclude  → Remove directories
 * 4. glob-exclude  → Remove pattern matches
 * 5. explicit      → Override with specific paths
 * 6. cap           → Post-process limit
 */
export type SelectionRuleType =
  | 'explicit' // Individual file paths (legacy compatibility + overrides)
  | 'glob-include' // Pattern-based inclusion
  | 'glob-exclude' // Pattern-based exclusion
  | 'root-include' // Include entire directory tree
  | 'root-exclude' // Exclude entire directory tree
  | 'cap'; // Limit total selection count

/**
 * Cap strategy determines how files are selected when limit is exceeded.
 */
export type CapStrategy =
  | 'first' // Take first N files (alphabetical/tree order)
  | 'last' // Take last N files
  | 'random' // Random sample (deterministic with seed)
  | 'priority'; // Use rule priority ordering

// ============================================================================
// Base Rule Interface
// ============================================================================

/** Base rule structure shared by all rule types */
export interface SelectionRuleBase {
  /** ISO 8601 creation timestamp */
  createdAt: string;

  /** Rule is active when true (default: true if omitted) */
  enabled?: boolean;
  /** Unique identifier for the rule (UUID recommended) */
  id: string;

  /** Human-readable description for UI display */
  label?: string;

  /**
   * Priority within same type (higher = evaluated first).
   * Default: 0. Rules with same priority use creation order.
   */
  priority?: number;

  /** Rule type determines evaluation behavior */
  type: SelectionRuleType;
}

// ============================================================================
// Concrete Rule Types
// ============================================================================

/**
 * Explicit file selection rule.
 *
 * Used for:
 * - Legacy v0 compatibility (migrated from Set<string>)
 * - Override behavior (explicit paths bypass other rules)
 * - User-pinned selections
 */
export type ExplicitRule = SelectionRuleBase & {
  type: 'explicit';

  /**
   * Array of file paths relative to folder root.
   * NOT composite keys — folderId is provided by SelectionRuleSet.
   */
  paths: string[];

  /**
   * Mode determines how explicit paths interact with other rules.
   * - 'include': Force include these paths (default)
   * - 'exclude': Force exclude these paths
   */
  mode?: 'include' | 'exclude';
};

/**
 * Glob pattern inclusion rule.
 *
 * Uses micromatch-compatible glob patterns.
 * @see https://github.com/micromatch/micromatch
 */
export type GlobIncludeRule = SelectionRuleBase & {
  type: 'glob-include';

  /**
   * Glob patterns to match.
   * Examples: "**\/*.ts", "src/**\/*.tsx", "*.json"
   */
  patterns: string[];

  /**
   * Optional base path for pattern matching.
   * Patterns are matched relative to this path.
   */
  basePath?: string;
};

/**
 * Glob pattern exclusion rule.
 *
 * Removes files matching patterns from the selection.
 */
export type GlobExcludeRule = SelectionRuleBase & {
  type: 'glob-exclude';

  /**
   * Glob patterns to exclude.
   * Examples: "**\/*.test.ts", "**\/node_modules/**"
   */
  patterns: string[];

  /** Optional base path for pattern matching */
  basePath?: string;
};

/**
 * Root directory inclusion rule.
 *
 * Includes all files within specified directory trees.
 */
export type RootIncludeRule = SelectionRuleBase & {
  type: 'root-include';

  /**
   * Directory paths to include recursively.
   * Paths are relative to folder root.
   */
  roots: string[];

  /**
   * Maximum depth to traverse (undefined = unlimited).
   * 0 = only files in root itself, 1 = root + immediate children, etc.
   */
  maxDepth?: number;
};

/**
 * Root directory exclusion rule.
 *
 * Excludes all files within specified directory trees.
 */
export type RootExcludeRule = SelectionRuleBase & {
  type: 'root-exclude';

  /**
   * Directory paths to exclude recursively.
   * Common examples: "node_modules", "dist", ".git"
   */
  roots: string[];
};

/**
 * Selection cap/limit rule.
 *
 * Applied as post-processing after all other rules.
 * Only one cap rule should be active at a time.
 */
export type CapRule = SelectionRuleBase & {
  type: 'cap';

  /** Maximum number of files in materialized selection */
  maxCount: number;

  /** Strategy when cap exceeded */
  strategy: CapStrategy;

  /**
   * Random seed for 'random' strategy.
   * Ensures deterministic sampling across materializations.
   */
  seed?: number;
};

// ============================================================================
// Union Type
// ============================================================================

/** Union of all concrete rule types */
export type SelectionRule =
  | ExplicitRule
  | GlobIncludeRule
  | GlobExcludeRule
  | RootIncludeRule
  | RootExcludeRule
  | CapRule;

// ============================================================================
// Rule Set
// ============================================================================

/** Metadata about a rule set */
export interface SelectionRuleSetMetadata {
  /** ISO 8601 creation timestamp */
  createdAt: string;

  /** Optional description of the rule set */
  description?: string;

  /**
   * Source of migration (if migrated from v0).
   * Used for analytics and debugging.
   */
  migratedFrom?: 'explicit-set';

  /** ISO 8601 last update timestamp */
  updatedAt: string;
}

/**
 * Complete rule set for a folder context.
 *
 * Each workspace folder has one SelectionRuleSet.
 * Rules are evaluated in type precedence order, then by priority within type.
 */
export interface SelectionRuleSet {
  /** Associated folder ID (workspace context) */
  folderId: string;

  /** Rule set metadata */
  metadata: SelectionRuleSetMetadata;

  /**
   * Ordered list of rules.
   * Order matters for rules of the same type and priority.
   */
  rules: SelectionRule[];
  /** Schema version for migrations */
  version: SelectionRulesSchemaVersion;
}

// ============================================================================
// Materialization Result
// ============================================================================

/** Warning generated during materialization */
export interface MaterializationWarning {
  /** Warning code for programmatic handling */
  code: 'pattern-no-match' | 'root-not-found' | 'cap-applied' | 'rule-disabled';

  /** Human-readable warning message */
  message: string;

  /** ID of the rule that generated the warning */
  ruleId?: string;
}

/**
 * Result of materializing a rule set against a file tree.
 *
 * This is the "contract" downstream consumers receive.
 */
export interface MaterializedSelection {
  /** IDs of rules that contributed to the selection */
  appliedRules: string[];

  /** Whether a cap rule was applied */
  capped: boolean;

  /** Timestamp of materialization (for caching) */
  materializedAt: string;

  /** Original count before cap (equals paths.size if not capped) */
  originalCount: number;
  /**
   * Final set of selected file paths.
   * Paths are relative to folderId, NOT composite keys.
   */
  paths: Set<string>;

  /** Any warnings during materialization */
  warnings: MaterializationWarning[];
}

// ============================================================================
// Type Guards
// ============================================================================

/** Type guard for ExplicitRule */
export function isExplicitRule(rule: SelectionRule): rule is ExplicitRule {
  return rule.type === 'explicit';
}

/** Type guard for GlobIncludeRule */
export function isGlobIncludeRule(rule: SelectionRule): rule is GlobIncludeRule {
  return rule.type === 'glob-include';
}

/** Type guard for GlobExcludeRule */
export function isGlobExcludeRule(rule: SelectionRule): rule is GlobExcludeRule {
  return rule.type === 'glob-exclude';
}

/** Type guard for RootIncludeRule */
export function isRootIncludeRule(rule: SelectionRule): rule is RootIncludeRule {
  return rule.type === 'root-include';
}

/** Type guard for RootExcludeRule */
export function isRootExcludeRule(rule: SelectionRule): rule is RootExcludeRule {
  return rule.type === 'root-exclude';
}

/** Type guard for CapRule */
export function isCapRule(rule: SelectionRule): rule is CapRule {
  return rule.type === 'cap';
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an empty rule set for a folder.
 */
export function createEmptyRuleSet(folderId: string): SelectionRuleSet {
  const now = new Date().toISOString();
  return {
    version: SELECTION_RULES_SCHEMA_VERSION,
    folderId,
    rules: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Create an empty materialized selection.
 */
export function createEmptyMaterializedSelection(): MaterializedSelection {
  return {
    paths: new Set(),
    appliedRules: [],
    capped: false,
    originalCount: 0,
    warnings: [],
    materializedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Defaults
// ============================================================================

/** Default maximum selection count (matches legacy maxSelectionCount) */
export const DEFAULT_MAX_SELECTION_COUNT = 10;

/** Common exclusion patterns for source code projects */
export const DEFAULT_EXCLUDE_ROOTS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
] as const;

/** Common include patterns for TypeScript projects */
export const DEFAULT_INCLUDE_PATTERNS: readonly string[] = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.json',
] as const;
