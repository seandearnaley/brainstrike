import type { FileFilterOptions, IFileNode } from '@brainstrike/types';
import { Minimatch } from 'minimatch';
import { createLogger } from './logger';

/**
 * Common file patterns to ignore
 */
const DEFAULT_IGNORE_PATTERNS = ['.git', 'node_modules', '.next', 'dist', 'build', '.DS_Store'];

// Pre-compile the ignore regex for performance
// Matches any path segment that equals one of the ignore patterns
// (?:^|[\\/]) matches start of string or a separator
// (?:$|[\\/]) matches end of string or a separator
const IGNORE_REGEX = new RegExp(
  `(?:^|[\\\\/])(?:${DEFAULT_IGNORE_PATTERNS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:$|[\\\\/])`
);

// Cache compiled regex and wildcard matchers to avoid repeated compilation work.
// Intentionally unbounded: expected pattern cardinality is small in this flow.
// If that assumption changes, migrate these module-level cache structures to bounded/LRU behavior.
const regexCache = new Map<string, RegExp>();
// Track known-invalid regex patterns so we only log once per pattern.
const invalidRegexPatterns = new Set<string>();
const minimatchCache = new Map<string, Minimatch>();

let logger: ReturnType<typeof createLogger> | undefined;

const getLogger = (): ReturnType<typeof createLogger> => {
  if (!logger) {
    logger = createLogger('fileFilter');
  }
  return logger;
};

const getOrCreateWildcardMatcher = (pattern: string): Minimatch => {
  let matcher = minimatchCache.get(pattern);
  if (!matcher) {
    matcher = new Minimatch(pattern, { dot: true });
    minimatchCache.set(pattern, matcher);
  }
  return matcher;
};

const getRegexMatcher = (pattern: string): RegExp | null => {
  const cachedRegex = regexCache.get(pattern);
  if (cachedRegex) {
    return cachedRegex;
  }

  if (invalidRegexPatterns.has(pattern)) {
    return null;
  }

  try {
    // Patterns are expected to come from trusted filter configuration.
    // If this ever becomes untrusted input, add complexity safeguards.
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
   * Checks if a path should be ignored based on default patterns
   */
  shouldIgnorePath(path: string): boolean {
    return IGNORE_REGEX.test(path);
  },

  /**
   * Matches a string against a wildcard pattern
   */
  matchWildcard(str: string, pattern: string): boolean {
    return matchWildcardPattern(str, pattern);
  },

  /**
   * Matches a string against a regex pattern
   */
  matchRegex(str: string, pattern: string): boolean {
    const regex = getRegexMatcher(pattern);
    return regex ? regex.test(str) : false;
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
      const filteredChildren: IFileNode[] = [];
      for (const child of node.children) {
        const filtered = this._filterNodeRecursive(child, includeMatchers, excludeMatchers);
        if (filtered) {
          filteredChildren.push(filtered);
        }
      }

      const directoryMatches =
        includeMatchers.length === 0 || this._matchesAny(node.path, includeMatchers);

      // If directory doesn't match include filters and has no matching children,
      // exclude it from the results
      if (!directoryMatches && filteredChildren.length === 0) {
        return null;
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
   * Applies filters to a file node
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
};
