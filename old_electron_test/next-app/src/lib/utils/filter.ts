import type { FileFilterOptions, IFileNode } from '@/lib/file/types';
import { minimatch } from 'minimatch';

/**
 * Common file patterns to ignore
 */
const DEFAULT_IGNORE_PATTERNS = ['.git', 'node_modules', '.next', 'dist', 'build', '.DS_Store'];

/**
 * Utilities for filtering files and directories
 */
export const fileFilter = {
  /**
   * Checks if a path should be ignored based on default patterns
   */
  shouldIgnorePath(path: string): boolean {
    return DEFAULT_IGNORE_PATTERNS.some((pattern) => path.split('/').includes(pattern));
  },

  /**
   * Matches a string against a wildcard pattern
   */
  matchWildcard(str: string, pattern: string): boolean {
    return minimatch(str, pattern, { dot: true });
  },

  /**
   * Matches a string against a regex pattern
   */
  matchRegex(str: string, pattern: string): boolean {
    try {
      return new RegExp(pattern).test(str);
    } catch (error) {
      console.warn(`Invalid regex pattern: ${pattern}`, error);
      return false;
    }
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
      excludeFilters.some((pattern) => matchFn(node.path, pattern))
    ) {
      return null;
    }

    // Finally check include filters
    if (
      includeFilters.length > 0 &&
      !includeFilters.some((pattern) => matchFn(node.path, pattern))
    ) {
      return null;
    }

    // For directories, recursively filter children
    if (node.type === 'directory' && node.children) {
      const filteredChildren = node.children
        .map((child) => this.filterNode(child, { includeFilters, excludeFilters, useRegex }))
        .filter((child): child is IFileNode => child !== null);

      return {
        ...node,
        children: filteredChildren,
      };
    }

    return node;
  },
};
