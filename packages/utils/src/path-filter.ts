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
// Track known-invalid regex patterns so we only log once per pattern.
const invalidRegexPatterns = new Set<string>();
// Cache compiled minimatch patterns to avoid recompilation overhead
const minimatchCache = new Map<string, Minimatch>();

const fileFilterLogger = createLogger('fileFilter');

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
    const regex = new RegExp(pattern);
    regexCache.set(pattern, regex);
    return regex;
  } catch (error: unknown) {
    invalidRegexPatterns.add(pattern);
    fileFilterLogger.warn(`Invalid regex pattern: ${pattern}`, error);
    return null;
  }
};

const matchWildcardPattern = (str: string, pattern: string): boolean => {
  if (pattern === '') {
    return str === '';
  }

  const matcher = getOrCreateWildcardMatcher(pattern);
  return matcher.match(str);
};

const createWildcardMatcher = (pattern: string): ((str: string) => boolean) => {
  return (str: string) => matchWildcardPattern(str, pattern);
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

    return createWildcardMatcher(pattern);
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
