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

function cloneNode(node: IFileNode, keepChildren: boolean): IFileNode {
  const newNode: IFileNode = { ...node, isVisible: true };
  if (node.children && keepChildren) {
    newNode.children = [...node.children];
  } else if (node.children) {
    newNode.children = [];
  }
  return newNode;
}

function normalizeNodePath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function processDirectoryNode(
  node: IFileNode,
  processTree: (nodes: IFileNode[]) => IFileNode[]
): IFileNode {
  const cloned = cloneNode(node, false);
  if (node.children && node.children.length > 0) {
    cloned.children = processTree(node.children);
  }
  return cloned;
}

function processFileNode(
  node: IFileNode,
  path: string,
  matchesInclude: (path: string) => boolean
): IFileNode | null {
  if (matchesInclude(path)) {
    return cloneNode(node, true);
  }
  return null;
}

function setupRegexFilters(
  processedIncludeFilters: string[],
  processedExcludeFilters: string[],
  regexCache: React.MutableRefObject<{ include: RegExp[]; exclude: RegExp[] }>,
  setError: (msg: string) => void
): boolean {
  const includes = compileRegexPatterns(processedIncludeFilters, setError);
  if (!includes) return false;

  const excludes = compileRegexPatterns(processedExcludeFilters, setError);
  if (!excludes) return false;

  regexCache.current.include = includes;
  regexCache.current.exclude = excludes;
  return true;
}

function createFilterFunctions(
  processedIncludeFilters: string[],
  processedExcludeFilters: string[],
  regexCache: React.MutableRefObject<{ include: RegExp[]; exclude: RegExp[] }>,
  useRegex: boolean
) {
  const matchesInclude = (path: string): boolean => {
    if (processedIncludeFilters.length === 0) return true;
    return matchPath(path, processedIncludeFilters, regexCache.current.include, useRegex);
  };

  const matchesExclude = (path: string): boolean =>
    matchPath(path, processedExcludeFilters, regexCache.current.exclude, useRegex);

  return { matchesInclude, matchesExclude };
}

function createProcessTreeFunction(
  matchesInclude: (path: string) => boolean,
  matchesExclude: (path: string) => boolean
) {
  const processTree = (nodes: IFileNode[]): IFileNode[] => {
    const result: IFileNode[] = [];
    for (const node of nodes) {
      const path = normalizeNodePath(node.path);
      if (matchesExclude(path)) continue;

      if (node.type === 'directory') {
        result.push(processDirectoryNode(node, processTree));
      } else if (node.type === 'file') {
        const processedFile = processFileNode(node, path, matchesInclude);
        if (processedFile) {
          result.push(processedFile);
        }
      }
    }
    return result;
  };

  return processTree;
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
      // Only clear error if there was one, to avoid unnecessary state updates
      if (filterError !== null) {
        setFilterError(null);
      }
      regexCache.current = { include: [], exclude: [] };

      const processedIncludeFilters = useRegex ? includeFilters : includeFilters.map(processFilter);
      const processedExcludeFilters = useRegex ? excludeFilters : excludeFilters.map(processFilter);

      if (useRegex) {
        const success = setupRegexFilters(
          processedIncludeFilters,
          processedExcludeFilters,
          regexCache,
          setFilterError
        );
        if (!success) return [];
      }

      const { matchesInclude, matchesExclude } = createFilterFunctions(
        processedIncludeFilters,
        processedExcludeFilters,
        regexCache,
        useRegex
      );

      const processTree = createProcessTreeFunction(matchesInclude, matchesExclude);

      return processTree(fileTree);
    },
    [filterError]
  );

  return { applyFileFilters, filterError };
}
