import type { IFileNode } from '@brainstrike/types';
import { parseFilterString } from '@brainstrike/utils';
import { useCallback, useMemo, useState } from 'react';
// New file: useQuickFilter hook
import { useDebouncedValue } from './use-debounced-value';

/**
 * A hook that provides debounced include/exclude filtering over a tree of IFileNode.
 */
export function useQuickFilter(fileTree: IFileNode[]) {
  const [quickFilter, setQuickFilter] = useState('');
  const debouncedFilter = useDebouncedValue(quickFilter, 150);

  const applyQuickFilter = useCallback((nodes: IFileNode[], filter: string): IFileNode[] => {
    if (!filter.trim()) return nodes;

    const { includes, excludes } = parseFilterString(filter);

    return nodes
      .map((node) => {
        const searchableText = [node.name.toLowerCase(), node.path.toLowerCase()].join(' ');

        // Exclude matching nodes
        const isExcluded = excludes.some((exclude) => searchableText.includes(exclude));
        if (isExcluded) {
          return null;
        }

        // Include logic
        const isIncluded =
          includes.length === 0 || includes.some((include) => searchableText.includes(include));

        if (node.type === 'directory' && node.children) {
          const filteredChildren = applyQuickFilter(node.children, filter);
          if (filteredChildren.length > 0) {
            return { ...node, children: filteredChildren };
          }
          if (isIncluded) {
            return { ...node, children: [] };
          }
          return null;
        }

        return isIncluded ? node : null;
      })
      .filter(Boolean) as IFileNode[];
  }, []);

  const filteredTree = useMemo(
    () => applyQuickFilter(fileTree, debouncedFilter),
    [fileTree, debouncedFilter, applyQuickFilter]
  );

  const clearFilter = useCallback(() => {
    setQuickFilter('');
  }, []);

  return {
    quickFilter,
    setQuickFilter,
    filteredTree,
    clearFilter,
  };
}
