import type { IFileNode } from '@/lib/file/types';
import { processFilter } from '@/utils/filter-utils';
import { minimatch } from 'minimatch';
import { useCallback, useRef, useState } from 'react';

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

      const shouldIncludeNode = (node: IFileNode): boolean => {
        const path = node.path.startsWith('/') ? node.path.slice(1) : node.path;

        // Exclude filters
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
              return false;
            }
          } else {
            if (minimatch(path, pattern)) {
              return false;
            }
          }
        }

        // Include filters
        if (node.type === 'file') {
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
        }

        // Always include directories
        return true;
      };

      const filterNode = (node: IFileNode): IFileNode | null => {
        if (!shouldIncludeNode(node)) return null;

        if (node.type === 'directory' && node.children) {
          const filteredChildren = node.children
            .map(filterNode)
            .filter((child): child is IFileNode => child !== null);

          return { ...node, children: filteredChildren, isVisible: true };
        }
        return { ...node, isVisible: true };
      };

      return fileTree.map(filterNode).filter((node): node is IFileNode => node !== null);
    },
    []
  );

  return { applyFileFilters, filterError };
}
