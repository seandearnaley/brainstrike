import type { IFileNode } from '@brainstrike/types';
import { minimatch } from 'minimatch';
import { useCallback, useRef, useState } from 'react';
import { processFilter } from '../utils/filter-utils';

export function useFileFilters() {
  const regexCache = useRef<{ [pattern: string]: RegExp | null }>({});
  const [filterError, setFilterError] = useState<string | null>(null);

  const applyFileFilters = useCallback(
    (
      fileTree: IFileNode[],
      includeFilters: string[],
      excludeFilters: string[] = [],
      useRegex = false
    ): IFileNode[] => {
      setFilterError(null); // Reset filter error
      regexCache.current = {}; // Clear regex cache

      const processedIncludeFilters = useRegex ? includeFilters : includeFilters.map(processFilter);
      const processedExcludeFilters = useRegex ? excludeFilters : excludeFilters.map(processFilter);

      // Validate regex patterns if useRegex is true
      if (useRegex) {
        for (const pattern of [...processedIncludeFilters, ...processedExcludeFilters]) {
          try {
            // Attempt to compile regex
            new RegExp(pattern);
          } catch (_) {
            setFilterError(`Invalid regex pattern: ${pattern}`);
            // Stop processing if any pattern is invalid
            return [];
          }
        }
      }

      // Function to check if a file path matches include filters
      const matchesIncludeFilters = (path: string): boolean => {
        // If no include filters, include everything
        if (processedIncludeFilters.length === 0) return true;

        for (const pattern of processedIncludeFilters) {
          if (useRegex) {
            let regex = regexCache.current[pattern];
            if (regex === undefined) {
              try {
                regex = new RegExp(pattern);
                regexCache.current[pattern] = regex;
              } catch {
                continue; // Skip invalid pattern
              }
            }
            if (regex?.test(path)) {
              return true;
            }
          } else {
            if (minimatch(path, pattern)) {
              return true;
            }
          }
        }
        return false;
      };

      // Function to check if a path matches exclude filters
      const matchesExcludeFilters = (path: string): boolean => {
        for (const pattern of processedExcludeFilters) {
          if (useRegex) {
            let regex = regexCache.current[pattern];
            if (regex === undefined) {
              try {
                regex = new RegExp(pattern);
                regexCache.current[pattern] = regex;
              } catch {
                continue; // Skip invalid pattern
              }
            }
            if (regex?.test(path)) {
              return true;
            }
          } else {
            if (minimatch(path, pattern)) {
              return true;
            }
          }
        }
        return false;
      };

      // Deep clone a file node with filtered children
      const cloneNode = (node: IFileNode, keepChildren: boolean): IFileNode => {
        const newNode = { ...node, isVisible: true };
        if (node.children && keepChildren) {
          newNode.children = [...node.children];
        } else if (node.children) {
          newNode.children = [];
        }
        return newNode;
      };

      // Process the file tree recursively
      const processTree = (nodes: IFileNode[]): IFileNode[] => {
        const result: IFileNode[] = [];

        for (const node of nodes) {
          const path = node.path.startsWith('/') ? node.path.slice(1) : node.path;

          // Check if this path should be excluded
          if (matchesExcludeFilters(path)) {
            continue; // Skip this node entirely
          }

          if (node.type === 'directory') {
            // Directories are always included but their children may be filtered
            const clonedDir = cloneNode(node, false);

            if (node.children && node.children.length > 0) {
              // Recursively process children
              clonedDir.children = processTree(node.children);
            }

            result.push(clonedDir);
          } else if (node.type === 'file') {
            // Files are included only if they match include filters
            if (matchesIncludeFilters(path)) {
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
