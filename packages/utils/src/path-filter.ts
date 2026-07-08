import type { FileFilterOptions, IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { Minimatch } from 'minimatch';

/**
 * Common file patterns to ignore
 */
const DEFAULT_IGNORE_PATTERNS = [
  '.git',
  'node_modules',
  '.pnpm-store',
  '.next',
  '.turbo',
  'dist',
  'build',
  '.DS_Store',
];

// Pre-compile the ignore regex for performance
// Matches any path segment that equals one of the ignore patterns
// (?:^|[\\/]) matches start of string or a separator
// (?:$|[\\/]) matches end of string or a separator
const IGNORE_REGEX = new RegExp(
  `(?:^|[\\\\/])(?:${DEFAULT_IGNORE_PATTERNS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:$|[\\\\/])`
);

// Module-level caches for compiled regex, wildcard matchers, and known-invalid patterns.
// Intentionally unbounded: expected pattern cardinality is small in this flow.
// If that assumption changes, migrate these cache structures to bounded/LRU behavior.
const regexCache = new Map<string, RegExp>();
const invalidRegexPatterns = new Set<string>();
const minimatchCache = new Map<string, Minimatch>();
const MAX_REGEX_PATTERN_LENGTH = 256;
const UNSAFE_REGEX_PATTERNS = [
  /\\[1-9]/, // backreferences can explode search time and are unnecessary here
  /\(\?<([=!])/, // lookbehind
  /\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[+*{]/, // nested quantifiers
];

const getLogger = (): ReturnType<typeof createLogger> => createLogger('fileFilter');

const getOrCreateWildcardMatcher = (pattern: string): Minimatch => {
  let matcher = minimatchCache.get(pattern);
  if (!matcher) {
    matcher = new Minimatch(pattern, { dot: true });
    minimatchCache.set(pattern, matcher);
  }
  return matcher;
};

function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return false;
  }

  return UNSAFE_REGEX_PATTERNS.every((unsafePattern) => !unsafePattern.test(pattern));
}

const getRegexMatcher = (pattern: string): RegExp | null => {
  const cachedRegex = regexCache.get(pattern);
  if (cachedRegex) {
    return cachedRegex;
  }

  if (invalidRegexPatterns.has(pattern)) {
    return null;
  }

  if (!isSafeRegexPattern(pattern)) {
    invalidRegexPatterns.add(pattern);
    getLogger().warn(`Rejected unsafe regex pattern: ${pattern}`);
    return null;
  }

  try {
    const regex = new RegExp(pattern);
    regexCache.set(pattern, regex);
    return regex;
  } catch (error: unknown) {
    invalidRegexPatterns.add(pattern);
    getLogger().warn(`Invalid regex pattern: ${pattern}`, error);
    return null;
  }
};

const matchWildcardPattern = (str: string, pattern: string): boolean => {
  if (pattern === '') {
    // Fast path: avoid constructing a Minimatch instance for empty patterns.
    // Empty patterns can come from blank include/exclude inputs; preserve Minimatch('') semantics.
    return str === '';
  }

  const matcher = getOrCreateWildcardMatcher(pattern);
  return matcher.match(str);
};

/**
 * Utilities for filtering files and directories
 */
export const fileFilter = {
  /**
   * Helper to filter children of a directory
   *
   * @internal Internal recursive helper used by _filterNodeRecursive.
   */
  _filterChildren(
    children: IFileNode[],
    includeMatchers: ((str: string) => boolean)[],
    excludeMatchers: ((str: string) => boolean)[]
  ): { filteredChildren: IFileNode[]; hasChanges: boolean } {
    let filteredChildren: IFileNode[] | null = null;
    let index = 0;

    for (const child of children) {
      const filtered = this._filterNodeRecursive(child, includeMatchers, excludeMatchers);
      if (filtered !== child && !filteredChildren) {
        // First change detected — back-fill with preceding unchanged children
        filteredChildren = children.slice(0, index);
      }
      if (filteredChildren && filtered) {
        filteredChildren.push(filtered);
      }
      index++;
    }

    return filteredChildren
      ? { filteredChildren, hasChanges: true }
      : { filteredChildren: children, hasChanges: false };
  },

  /**
   * Internal recursive filter function using pre-compiled matchers
   *
   * @internal Internal recursive helper used by filterNode.
   */
  _filterNodeRecursive(
    node: IFileNode,
    includeMatchers: ((str: string) => boolean)[],
    excludeMatchers: ((str: string) => boolean)[]
  ): IFileNode | null {
    // First check if path should be ignored
    if (this.shouldIgnorePath(node.path)) {
      return null;
    }

    // Then check exclude filters
    if (excludeMatchers.length > 0 && this._matchesAny(node.path, excludeMatchers)) {
      return null;
    }

    if (node.type === 'directory' && node.children) {
      // Recursively filter children first
      const { filteredChildren, hasChanges } = this._filterChildren(
        node.children,
        includeMatchers,
        excludeMatchers
      );

      const directoryMatches =
        includeMatchers.length === 0 || this._matchesAny(node.path, includeMatchers);

      // If directory doesn't match include filters and has no matching children,
      // exclude it from the results
      if (!directoryMatches && filteredChildren.length === 0) {
        return null;
      }

      // Structural sharing: return the original node when children are unchanged.
      // Callers must not mutate returned nodes — they may share references with the input tree.
      if (!hasChanges) {
        return node;
      }

      return {
        ...node,
        children: filteredChildren,
      };
    }

    // For files, apply include filters after exclude checks
    if (includeMatchers.length > 0 && !this._matchesAny(node.path, includeMatchers)) {
      return null;
    }

    return node;
  },

  /**
   * Checks if a path matches any of the provided matchers
   *
   * @internal Internal recursive helper used by filterNode.
   */
  _matchesAny(path: string, matchers: ((str: string) => boolean)[]): boolean {
    for (const matcher of matchers) {
      if (matcher(path)) {
        return true;
      }
    }
    return false;
  },

  /**
   * Creates a matcher function for a given pattern
   */
  createMatcher(pattern: string, useRegex: boolean): (str: string) => boolean {
    if (useRegex) {
      const regex = getRegexMatcher(pattern);
      if (!regex) {
        return () => false;
      }
      return (str: string) => regex.test(str);
    }

    const matcher = getOrCreateWildcardMatcher(pattern);
    return (str: string) => matcher.match(str);
  },

  /**
   * Applies filters to a file node.
   *
   * Uses structural sharing: when no children are filtered, the original node reference is returned.
   * Callers must not mutate the returned tree — it may share references with the input.
   */
  filterNode(
    node: IFileNode,
    { includeFilters, excludeFilters, useRegex }: FileFilterOptions
  ): IFileNode | null {
    // Optimization: Pre-compile matchers once at the top level
    // This avoids repeated map lookups and regex/minimatch instantiation/retrieval for every node in the tree
    const includeMatchers = includeFilters.map((p) => this.createMatcher(p, !!useRegex));
    const excludeMatchers = excludeFilters.map((p) => this.createMatcher(p, !!useRegex));

    return this._filterNodeRecursive(node, includeMatchers, excludeMatchers);
  },

  /**
   * Matches a string against a regex pattern
   */
  matchRegex(str: string, pattern: string): boolean {
    const regex = getRegexMatcher(pattern);
    return regex ? regex.test(str) : false;
  },

  /**
   * Matches a string against a wildcard pattern
   */
  matchWildcard(str: string, pattern: string): boolean {
    return matchWildcardPattern(str, pattern);
  },
  /**
   * Checks if a path should be ignored based on default patterns
   */
  shouldIgnorePath(path: string): boolean {
    return IGNORE_REGEX.test(path);
  },
};
