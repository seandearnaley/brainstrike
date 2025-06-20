import type { IFileNode } from '@brainstrike/types';
import { processFilter } from '@brainstrike/utils';
import { minimatch } from 'minimatch';
import { useCallback, useRef, useState } from 'react';

function compileRegexPatterns(
  patterns: string[],
  setError: (msg: string) => void
): RegExp[] | null {
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      regexes.push(new RegExp(pattern));
    } catch {
      setError(`Invalid regex pattern: ${pattern}`);
      return null;
    }
  }
  return regexes;
}

function matchPath(path: string, globs: string[], regexes: RegExp[], useRegex: boolean): boolean {
  if (useRegex) {
    return regexes.some((regex) => regex.test(path));
  }
  return globs.some((pattern) => minimatch(path, pattern));
}

/**
 * A hook that applies include/exclude filters (glob or regex) to a tree of IFileNode.
 * @returns applyFileFilters: function to filter a node tree, and filterError: error message if regex is invalid
 */
export function useFileFilters() {
  const regexCache = useRef<{ include: RegExp[]; exclude: RegExp[] }>({
    include: [],
    exclude: [],
  });
  const [filterError, setFilterError] = useState<string | null>(null);

  const applyFileFilters = useCallback(
    (
      fileTree: IFileNode[],
      includeFilters: string[],
      excludeFilters: string[] = [],
      useRegex = false
    ): IFileNode[] => {
      setFilterError(null);
      regexCache.current = { include: [], exclude: [] };

      const processedIncludeFilters = useRegex ? includeFilters : includeFilters.map(processFilter);
      const processedExcludeFilters = useRegex ? excludeFilters : excludeFilters.map(processFilter);

      if (useRegex) {
        const includes = compileRegexPatterns(processedIncludeFilters, setFilterError);
        if (!includes) return [];

        const excludes = compileRegexPatterns(processedExcludeFilters, setFilterError);
        if (!excludes) return [];

        regexCache.current.include = includes;
        regexCache.current.exclude = excludes;
      }

      const matchesInclude = (path: string): boolean => {
        if (processedIncludeFilters.length === 0) return true;
        return matchPath(path, processedIncludeFilters, regexCache.current.include, useRegex);
      };

      const matchesExclude = (path: string): boolean =>
        matchPath(path, processedExcludeFilters, regexCache.current.exclude, useRegex);

      const cloneNode = (node: IFileNode, keepChildren: boolean): IFileNode => {
        const newNode: IFileNode = { ...node, isVisible: true };
        if (node.children && keepChildren) {
          newNode.children = [...node.children];
        } else if (node.children) {
          newNode.children = [];
        }
        return newNode;
      };

      const processTree = (nodes: IFileNode[]): IFileNode[] => {
        const result: IFileNode[] = [];
        for (const node of nodes) {
          const path = node.path.startsWith('/') ? node.path.slice(1) : node.path;
          if (matchesExclude(path)) continue;

          if (node.type === 'directory') {
            const cloned = cloneNode(node, false);
            if (node.children && node.children.length > 0) {
              cloned.children = processTree(node.children);
            }
            result.push(cloned);
          } else if (node.type === 'file') {
            if (matchesInclude(path)) {
              result.push(cloneNode(node, true));
            }
          }
        }
        return result;
      };

      return processTree(fileTree);
    },
    []
  );

  return { applyFileFilters, filterError };
}
