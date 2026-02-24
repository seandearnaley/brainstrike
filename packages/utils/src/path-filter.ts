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

// Cache compiled regex patterns to avoid recompilation overhead
const regexCache = new Map<string, RegExp>();
// Cache compiled minimatch patterns to avoid recompilation overhead
const minimatchCache = new Map<string, Minimatch>();

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
    return this.createMatcher(pattern, false)(str);
  },

  /**
   * Matches a string against a regex pattern
   */
  matchRegex(str: string, pattern: string): boolean {
    return this.createMatcher(pattern, true)(str);
  },

  /**
   * Creates a matcher function for a given pattern
   */
  createMatcher(pattern: string, useRegex: boolean): (str: string) => boolean {
    if (useRegex) {
      const cachedRegex = regexCache.get(pattern);
      if (cachedRegex) {
        return (str: string) => cachedRegex.test(str);
      }

      try {
        const regex = new RegExp(pattern);
        regexCache.set(pattern, regex);
        return (str: string) => regex.test(str);
      } catch (error) {
        const logger = createLogger('fileFilter');
        logger.warn(`Invalid regex pattern: ${pattern}`, error);
        return () => false;
      }
    }

    const cachedMatcher = minimatchCache.get(pattern);
    if (cachedMatcher) {
      return (str: string) => cachedMatcher.match(str);
    }

    const matcher = new Minimatch(pattern, { dot: true });
    minimatchCache.set(pattern, matcher);
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
