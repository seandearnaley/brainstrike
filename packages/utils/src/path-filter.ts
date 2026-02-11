import type { FileFilterOptions, IFileNode } from '@brainstrike/types';
import { Minimatch, minimatch } from 'minimatch';
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
    let matcher = minimatchCache.get(pattern);
    if (!matcher) {
      try {
        matcher = new Minimatch(pattern, { dot: true });
        minimatchCache.set(pattern, matcher);
      } catch (_error) {
        const logger = createLogger('fileFilter');
        logger.warn(`Invalid glob pattern: ${pattern}`, _error);
        return false;
      }
    }
    return matcher.match(str);
  },

  /**
   * Matches a string against a regex pattern
   */
  matchRegex(str: string, pattern: string): boolean {
    let regex = regexCache.get(pattern);
    if (!regex) {
      try {
        regex = new RegExp(pattern);
        regexCache.set(pattern, regex);
      } catch (_error) {
        const logger = createLogger('fileFilter');
        logger.warn(`Invalid regex pattern: ${pattern}`, _error);
        return false;
      }
    }
    return regex.test(str);
  },

  /**
   * Applies filters to a file node
   */
  filterNode(
    node: IFileNode,
    { includeFilters, excludeFilters, useRegex }: FileFilterOptions
  ): IFileNode | null {
    const matchFn = useRegex ? this.matchRegex : this.matchWildcard;

    // First check if path should be ignored
    if (this.shouldIgnorePath(node.path)) {
      return null;
    }

    // Then check exclude filters
    if (
      excludeFilters.length > 0 &&
      excludeFilters.some((pattern: string) => matchFn(node.path, pattern))
    ) {
      return null;
    }

    if (node.type === 'directory' && node.children) {
      // Recursively filter children first
      const filteredChildren = node.children
        .map((child: IFileNode) =>
          this.filterNode(child, { includeFilters, excludeFilters, useRegex })
        )
        .filter((child): child is IFileNode => child !== null);

      const directoryMatches =
        includeFilters.length === 0 ||
        includeFilters.some((pattern: string) => matchFn(node.path, pattern));

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
    if (
      includeFilters.length > 0 &&
      !includeFilters.some((pattern: string) => matchFn(node.path, pattern))
    ) {
      return null;
    }

    return node;
  },
};
