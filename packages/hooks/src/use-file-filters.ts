import type { IFileNode } from '@brainstrike/types';
import { processFilter } from '@brainstrike/utils';
import { minimatch } from 'minimatch';
import { useCallback, useRef, useState } from 'react';

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
        const includeRegexes: RegExp[] = [];
        for (const pattern of processedIncludeFilters) {
          try {
            includeRegexes.push(new RegExp(pattern));
          } catch (_) {
            setFilterError(`Invalid regex pattern: ${pattern}`);
            return [];
          }
        }

        const excludeRegexes: RegExp[] = [];
        for (const pattern of processedExcludeFilters) {
          try {
            excludeRegexes.push(new RegExp(pattern));
          } catch (_) {
            setFilterError(`Invalid regex pattern: ${pattern}`);
            return [];
          }
        }

        regexCache.current.include = includeRegexes;
        regexCache.current.exclude = excludeRegexes;
      }

      const matchesInclude = (path: string): boolean => {
        if (processedIncludeFilters.length === 0) return true;
        if (useRegex) {
          for (const regex of regexCache.current.include) {
            if (regex.test(path)) return true;
          }
        } else {
          for (const pattern of processedIncludeFilters) {
            if (minimatch(path, pattern)) return true;
          }
        }
        return false;
      };

      const matchesExclude = (path: string): boolean => {
        if (useRegex) {
          for (const regex of regexCache.current.exclude) {
            if (regex.test(path)) return true;
          }
        } else {
          for (const pattern of processedExcludeFilters) {
            if (minimatch(path, pattern)) return true;
          }
        }
        return false;
      };

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
