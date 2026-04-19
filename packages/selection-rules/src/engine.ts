/**
 * Selection Rule Engine
 *
 * Evaluates selection rules against file trees with support for:
 * - Lazy materialization (top-N with deterministic ordering)
 * - Incremental diff output when tree changes
 * - Count computation without full enumeration
 *
 * @see schema.ts for rule type definitions
 * @see apps/docs/docs/reference/adr/selection-rules-v1.md for evaluation semantics
 */

import { Minimatch } from 'minimatch';
import type {
  CapRule,
  ExplicitRule,
  GlobExcludeRule,
  GlobIncludeRule,
  MaterializationWarning,
  MaterializedSelection,
  RootExcludeRule,
  RootIncludeRule,
  SelectionRule,
  SelectionRuleSet,
} from './schema';
import {
  isCapRule,
  isExplicitRule,
  isGlobExcludeRule,
  isGlobIncludeRule,
  isRootExcludeRule,
  isRootIncludeRule,
} from './schema';

// ============================================================================
// Tree Adapter Interface
// ============================================================================

/**
 * Minimal file node representation for the engine.
 */
export interface FileNode {
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Relative path from folder root */
  path: string;
}

/**
 * Tree adapter interface for accessing file tree data.
 *
 * Implementations can lazily load data as needed.
 */
export interface TreeAdapter {
  /**
   * Get all file paths (non-directories) in the tree.
   *
   * @returns Iterable of file paths for lazy evaluation
   */
  getAllFilePaths(): Iterable<string>;

  /**
   * Get all files under a specific root directory.
   *
   * @param root - Directory path relative to folder root
   * @param maxDepth - Maximum depth to traverse (undefined = unlimited)
   * @returns Iterable of file paths
   */
  getFilesUnderRoot(root: string, maxDepth?: number): Iterable<string>;

  /**
   * Get total file count (for optimization).
   *
   * @returns Total number of files (non-directories)
   */
  getTotalFileCount(): number;

  /**
   * Check if a path exists in the tree.
   *
   * @param path - Path to check
   * @returns true if path exists
   */
  pathExists(path: string): boolean;
}

// ============================================================================
// Rule Precedence
// ============================================================================

/**
 * Rule type precedence order (higher = evaluated first in override phase).
 *
 * Evaluation flow:
 * 1. root-include → Start with directories
 * 2. glob-include → Add pattern matches
 * 3. root-exclude → Remove directories
 * 4. glob-exclude → Remove pattern matches
 * 5. explicit → Override with specific paths
 * 6. cap → Post-process limit
 */
const RULE_TYPE_PRECEDENCE: Record<SelectionRule['type'], number> = {
  'root-include': 1,
  'glob-include': 2,
  'root-exclude': 3,
  'glob-exclude': 4,
  explicit: 5,
  cap: 6,
};

const GLOB_MATCH_OPTIONS = { dot: true } as const;
const PATH_SEPARATOR_CODE = '/'.charCodeAt(0);

/**
 * Local path-boundary check for selection rules.
 * This package keeps its own helper so it can treat `path === root`
 * as a match without adding a runtime dependency on shared tree utils.
 */
function isEqualOrDescendantPath(path: string, root: string): boolean {
  return (
    path === root ||
    (path.length > root.length &&
      path.charCodeAt(root.length) === PATH_SEPARATOR_CODE &&
      path.startsWith(root))
  );
}

function countRelativeDepth(relativePath: string, maxDepth?: number): number {
  let depth = 0;
  for (let i = 0; i < relativePath.length; i += 1) {
    if (relativePath.charCodeAt(i) !== PATH_SEPARATOR_CODE) {
      continue;
    }
    depth += 1;
    if (maxDepth !== undefined && depth > maxDepth) {
      return depth;
    }
  }
  return depth;
}

/**
 * Sort rules by type precedence, then by priority within type.
 */
function sortRulesByPrecedence(rules: SelectionRule[]): SelectionRule[] {
  return [...rules].sort((a, b) => {
    const typeDiff = RULE_TYPE_PRECEDENCE[a.type] - RULE_TYPE_PRECEDENCE[b.type];
    if (typeDiff !== 0) {
      return typeDiff;
    }

    // Higher priority = evaluated first
    const priorityA = a.priority ?? 0;
    const priorityB = b.priority ?? 0;
    return priorityB - priorityA;
  });
}

// ============================================================================
// Materialization Options
// ============================================================================

/**
 * Options for materialization.
 */
export interface MaterializeOptions {
  /**
   * Maximum number of files to return (for lazy evaluation).
   * If not specified, returns all matching files.
   */
  limit?: number;

  /**
   * Random seed for deterministic sampling.
   * Used when cap strategy is 'random'.
   */
  seed?: number;
}

// ============================================================================
// Selection Diff
// ============================================================================

/**
 * Represents changes between two materialized selections.
 */
export interface SelectionDiff {
  /** Paths added in the new selection */
  added: Set<string>;

  /** Paths removed from the old selection */
  removed: Set<string>;

  /** Whether the selections are identical */
  unchanged: boolean;
}

// ============================================================================
// Selection Rule Engine
// ============================================================================

/**
 * Engine for evaluating selection rules against file trees.
 */
export class SelectionRuleEngine {
  private readonly ruleSet: SelectionRuleSet;
  private readonly sortedRules: SelectionRule[];
  private readonly enabledRules: SelectionRule[];

  constructor(ruleSet: SelectionRuleSet) {
    this.ruleSet = ruleSet;
    this.sortedRules = sortRulesByPrecedence(ruleSet.rules);
    this.enabledRules = this.sortedRules.filter((r) => r.enabled !== false);
  }

  /**
   * Get the rule set being evaluated.
   */
  getRuleSet(): SelectionRuleSet {
    return this.ruleSet;
  }

  /**
   * Materialize the selection against a tree adapter.
   *
   * @param tree - Tree adapter for accessing file data
   * @param options - Materialization options
   * @returns Materialized selection with applied rules and warnings
   */
  materialize(tree: TreeAdapter, options: MaterializeOptions = {}): MaterializedSelection {
    const warnings: MaterializationWarning[] = [];
    const appliedRules: string[] = [];

    this.collectDisabledWarnings(warnings);

    // Cache all file paths once for performance (avoids re-materializing for each glob rule)
    const allPaths = Array.from(tree.getAllFilePaths());

    let selection = this.processInclusionRules(tree, allPaths, warnings, appliedRules);
    selection = this.processExclusionRules(selection, warnings, appliedRules);
    selection = this.processExplicitRules(selection, tree, warnings, appliedRules);

    const originalCount = selection.size;
    const capResult = this.processCapRules(selection, options, warnings, appliedRules);

    return {
      paths: capResult.selection,
      appliedRules: [...new Set(appliedRules)],
      capped: capResult.capped,
      originalCount,
      warnings,
      materializedAt: new Date().toISOString(),
    };
  }

  private collectDisabledWarnings(warnings: MaterializationWarning[]): void {
    for (const rule of this.sortedRules) {
      if (rule.enabled === false) {
        warnings.push({
          code: 'rule-disabled',
          message: `Rule "${rule.label ?? rule.id}" is disabled`,
          ruleId: rule.id,
        });
      }
    }
  }

  private processInclusionRules(
    tree: TreeAdapter,
    allPaths: string[],
    warnings: MaterializationWarning[],
    appliedRules: string[]
  ): Set<string> {
    const selection = new Set<string>();

    for (const rule of this.enabledRules) {
      const added = this.getIncludedPaths(rule, tree, allPaths, warnings);
      if (added) {
        this.addPathsToSelection(added, selection, rule.id, appliedRules);
      }
    }

    return selection;
  }

  private getIncludedPaths(
    rule: SelectionRule,
    tree: TreeAdapter,
    allPaths: string[],
    warnings: MaterializationWarning[]
  ): Set<string> | null {
    if (isRootIncludeRule(rule)) {
      return this.applyRootInclude(rule, tree, warnings);
    }
    if (isGlobIncludeRule(rule)) {
      return this.applyGlobInclude(rule, allPaths, warnings);
    }
    return null;
  }

  private addPathsToSelection(
    paths: Set<string>,
    selection: Set<string>,
    ruleId: string,
    appliedRules: string[]
  ): void {
    for (const path of paths) {
      selection.add(path);
    }
    if (paths.size > 0) {
      appliedRules.push(ruleId);
    }
  }

  private processExclusionRules(
    selection: Set<string>,
    warnings: MaterializationWarning[],
    appliedRules: string[]
  ): Set<string> {
    let result = selection;

    for (const rule of this.enabledRules) {
      if (isRootExcludeRule(rule)) {
        const sizeBefore = result.size;
        result = this.applyRootExclude(rule, result, warnings);
        if (result.size < sizeBefore) {
          appliedRules.push(rule.id);
        }
      } else if (isGlobExcludeRule(rule)) {
        const sizeBefore = result.size;
        result = this.applyGlobExclude(rule, result, warnings);
        if (result.size < sizeBefore) {
          appliedRules.push(rule.id);
        }
      }
    }

    return result;
  }

  private processExplicitRules(
    selection: Set<string>,
    tree: TreeAdapter,
    warnings: MaterializationWarning[],
    appliedRules: string[]
  ): Set<string> {
    let result = selection;

    for (const rule of this.enabledRules) {
      if (isExplicitRule(rule)) {
        const sizeBefore = result.size;
        result = this.applyExplicit(rule, result, tree, warnings);
        if (result.size !== sizeBefore) {
          appliedRules.push(rule.id);
        }
      }
    }

    return result;
  }

  private processCapRules(
    selection: Set<string>,
    options: MaterializeOptions,
    warnings: MaterializationWarning[],
    appliedRules: string[]
  ): { selection: Set<string>; capped: boolean } {
    let result = selection;
    let capped = false;

    for (const rule of this.enabledRules) {
      if (isCapRule(rule)) {
        const capResult = this.applyCap(rule, result, options.seed, warnings);
        result = capResult.selection;
        capped = capResult.capped;
        if (capped) {
          appliedRules.push(rule.id);
        }
        break; // Only one cap rule should apply
      }
    }

    // Apply limit from options if specified and no cap rule
    if (!capped && options.limit !== undefined && result.size > options.limit) {
      const paths = Array.from(result).slice(0, options.limit);
      result = new Set(paths);
      capped = true;
    }

    return { selection: result, capped };
  }

  /**
   * Compute selection count without full materialization.
   *
   * This is an optimization for UI display - may be approximate.
   *
   * @param tree - Tree adapter
   * @returns Estimated count
   */
  estimateCount(tree: TreeAdapter): number {
    // For accurate counts, we need to materialize
    // This could be optimized with caching or rule-specific counting
    const result = this.materialize(tree);
    return result.paths.size;
  }

  /**
   * Compute diff between two selections.
   *
   * @param oldSelection - Previous selection
   * @param newSelection - New selection
   * @returns Diff with added/removed paths
   */
  static computeDiff(
    oldSelection: MaterializedSelection,
    newSelection: MaterializedSelection
  ): SelectionDiff {
    const added = new Set<string>();
    const removed = new Set<string>();

    for (const path of newSelection.paths) {
      if (!oldSelection.paths.has(path)) {
        added.add(path);
      }
    }

    for (const path of oldSelection.paths) {
      if (!newSelection.paths.has(path)) {
        removed.add(path);
      }
    }

    return {
      added,
      removed,
      unchanged: added.size === 0 && removed.size === 0,
    };
  }

  // ============================================================================
  // Rule Application Methods
  // ============================================================================

  private applyRootInclude(
    rule: RootIncludeRule,
    tree: TreeAdapter,
    warnings: MaterializationWarning[]
  ): Set<string> {
    const result = new Set<string>();

    for (const root of rule.roots) {
      if (!tree.pathExists(root)) {
        warnings.push({
          code: 'root-not-found',
          message: `Root "${root}" not found in tree`,
          ruleId: rule.id,
        });
        continue;
      }

      for (const path of tree.getFilesUnderRoot(root, rule.maxDepth)) {
        result.add(path);
      }
    }

    return result;
  }

  private applyGlobInclude(
    rule: GlobIncludeRule,
    allPaths: string[],
    warnings: MaterializationWarning[]
  ): Set<string> {
    const result = new Set<string>();

    for (const pattern of rule.patterns) {
      const fullPattern = rule.basePath ? `${rule.basePath}/${pattern}` : pattern;
      const matcher = new Minimatch(fullPattern, GLOB_MATCH_OPTIONS);
      const matches = allPaths.filter((path) => matcher.match(path));

      if (matches.length === 0) {
        warnings.push({
          code: 'pattern-no-match',
          message: `Pattern "${fullPattern}" matched no files`,
          ruleId: rule.id,
        });
      }

      for (const path of matches) {
        result.add(path);
      }
    }

    return result;
  }

  private applyRootExclude(
    rule: RootExcludeRule,
    selection: Set<string>,
    _warnings: MaterializationWarning[]
  ): Set<string> {
    const result = new Set<string>();

    for (const path of selection) {
      let excluded = false;
      for (const root of rule.roots) {
        if (isEqualOrDescendantPath(path, root)) {
          excluded = true;
          break;
        }
      }
      if (!excluded) {
        result.add(path);
      }
    }

    return result;
  }

  private applyGlobExclude(
    rule: GlobExcludeRule,
    selection: Set<string>,
    _warnings: MaterializationWarning[]
  ): Set<string> {
    // Start with a copy of all selected paths
    const result = new Set(selection);

    for (const pattern of rule.patterns) {
      const fullPattern = rule.basePath ? `${rule.basePath}/${pattern}` : pattern;
      const matcher = new Minimatch(fullPattern, GLOB_MATCH_OPTIONS);

      // Remove paths that match this exclusion pattern
      for (const path of result) {
        if (matcher.match(path)) {
          result.delete(path);
        }
      }
    }

    return result;
  }

  private applyExplicit(
    rule: ExplicitRule,
    selection: Set<string>,
    tree: TreeAdapter,
    warnings: MaterializationWarning[]
  ): Set<string> {
    const result = new Set(selection);
    const mode = rule.mode ?? 'include';

    for (const path of rule.paths) {
      if (mode === 'include') {
        if (tree.pathExists(path)) {
          result.add(path);
        } else {
          warnings.push({
            code: 'pattern-no-match',
            message: `Explicit path "${path}" not found`,
            ruleId: rule.id,
          });
        }
      } else {
        result.delete(path);
      }
    }

    return result;
  }

  private applyCap(
    rule: CapRule,
    selection: Set<string>,
    seedOverride: number | undefined,
    warnings: MaterializationWarning[]
  ): { selection: Set<string>; capped: boolean } {
    if (selection.size <= rule.maxCount) {
      return { selection, capped: false };
    }

    warnings.push({
      code: 'cap-applied',
      message: `Cap reduced selection from ${selection.size} to ${rule.maxCount}`,
      ruleId: rule.id,
    });

    const paths = Array.from(selection);
    let selectedPaths: string[];

    switch (rule.strategy) {
      case 'first':
        selectedPaths = paths.sort().slice(0, rule.maxCount);
        break;

      case 'last':
        selectedPaths = paths.sort().slice(-rule.maxCount);
        break;

      case 'random': {
        const seed = seedOverride ?? rule.seed ?? Date.now();
        selectedPaths = this.seededShuffle(paths, seed).slice(0, rule.maxCount);
        break;
      }

      case 'priority':
        // Priority strategy keeps first N in current order (rule application order)
        selectedPaths = paths.slice(0, rule.maxCount);
        break;

      default:
        selectedPaths = paths.slice(0, rule.maxCount);
    }

    return { selection: new Set(selectedPaths), capped: true };
  }

  /**
   * Deterministic shuffle using a seeded PRNG.
   */
  private seededShuffle(array: string[], seed: number): string[] {
    const result = [...array];
    let currentSeed = seed;

    // Simple LCG PRNG
    const random = (): number => {
      currentSeed = (currentSeed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return currentSeed / 0x7f_ff_ff_ff;
    };

    // Fisher-Yates shuffle
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const temp = result[i];
      result[i] = result[j] as string;
      result[j] = temp as string;
    }

    return result;
  }
}

// ============================================================================
// In-Memory Tree Adapter
// ============================================================================

/**
 * Simple in-memory tree adapter for testing.
 */
export class InMemoryTreeAdapter implements TreeAdapter {
  private readonly files: Map<string, FileNode>;
  private readonly directories: Set<string>;

  constructor(nodes: FileNode[]) {
    this.files = new Map();
    this.directories = new Set();

    for (const node of nodes) {
      if (node.isDirectory) {
        this.directories.add(node.path);
      } else {
        this.files.set(node.path, node);
      }
    }

    // Add implicit parent directories
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const parentPath = parts.slice(0, i).join('/');
        this.directories.add(parentPath);
      }
    }
  }

  getAllFilePaths(): Iterable<string> {
    return this.files.keys();
  }

  getFilesUnderRoot(root: string, maxDepth?: number): Iterable<string> {
    const result: string[] = [];
    const normalizedRoot = root.replace(/\/$/, '');

    for (const path of this.files.keys()) {
      if (isEqualOrDescendantPath(path, normalizedRoot)) {
        if (maxDepth !== undefined) {
          const relativePath = path.slice(normalizedRoot.length + 1);
          const depth = countRelativeDepth(relativePath, maxDepth);
          if (depth > maxDepth) {
            continue;
          }
        }
        result.push(path);
      }
    }

    return result;
  }

  pathExists(path: string): boolean {
    return this.files.has(path) || this.directories.has(path);
  }

  getTotalFileCount(): number {
    return this.files.size;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a selection rule engine from a rule set.
 */
export function createSelectionRuleEngine(ruleSet: SelectionRuleSet): SelectionRuleEngine {
  return new SelectionRuleEngine(ruleSet);
}
