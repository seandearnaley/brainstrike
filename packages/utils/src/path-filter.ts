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

function getWildcardMatcher(pattern: string): Minimatch {
  let matcher = minimatchCache.get(pattern);
  if (!matcher) {
    matcher = new Minimatch(pattern, { dot: true });
    minimatchCache.set(pattern, matcher);
  }
  return matcher;
}

function getRegexMatcher(pattern: string): RegExp | null {
  let regex = regexCache.get(pattern);
  if (!regex) {
    try {
      regex = new RegExp(pattern);
      regexCache.set(pattern, regex);
    } catch (_error) {
      const logger = createLogger('fileFilter');
      logger.warn(`Invalid regex pattern: ${pattern}`, _error);
      return null;
    }
  }
  return regex;
}

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
    return getWildcardMatcher(pattern).match(str);
  },

  /**
   * Matches a string against a regex pattern
   */
  matchRegex(str: string, pattern: string): boolean {
    const regex = getRegexMatcher(pattern);
    return regex ? regex.test(str) : false;
  },

  /**
   * Applies filters to a file node
   */
  filterNode(
    node: IFileNode,
    { includeFilters, excludeFilters, useRegex }: FileFilterOptions
  ): IFileNode | null {
    // Helper to get a matcher function for a pattern
    const getMatcher = (pattern: string): ((path: string) => boolean) => {
      if (useRegex) {
        const regex = getRegexMatcher(pattern);
        if (!regex) return () => false;
        return (path: string) => regex.test(path);
      } else {
        const matcher = getWildcardMatcher(pattern);
        return (path: string) => matcher.match(path);
      }
    };

    // Pre-compile matchers to avoid cache lookups during recursion
    const includeMatchers = includeFilters.map(getMatcher);
    const excludeMatchers = excludeFilters.map(getMatcher);

    // Recursive helper using compiled matchers
    const filterRecursive = (currentNode: IFileNode): IFileNode | null => {
      // First check if path should be ignored
      if (this.shouldIgnorePath(currentNode.path)) {
        return null;
      }

      // Then check exclude filters
      if (
        excludeMatchers.length > 0 &&
        excludeMatchers.some((matcher) => matcher(currentNode.path))
      ) {
        return null;
      }

      if (currentNode.type === 'directory' && currentNode.children) {
        // Recursively filter children first
        const filteredChildren = currentNode.children
          .map((child: IFileNode) => filterRecursive(child))
          .filter((child): child is IFileNode => child !== null);

        const directoryMatches =
          includeMatchers.length === 0 ||
          includeMatchers.some((matcher) => matcher(currentNode.path));

        // If directory doesn't match include filters and has no matching children,
        // exclude it from the results
        if (!directoryMatches && filteredChildren.length === 0) {
          return null;
        }

        return {
          ...currentNode,
          children: filteredChildren,
        };
      }

      // For files, apply include filters after exclude checks
      if (
        includeMatchers.length > 0 &&
        !includeMatchers.some((matcher) => matcher(currentNode.path))
      ) {
        return null;
      }

      return currentNode;
    };

    return filterRecursive(node);
  },
};
