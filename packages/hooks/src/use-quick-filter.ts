import type { IFileNode } from '@brainstrike/types';
import { parseFilterString } from '@brainstrike/utils/quick-filter-utils';
import { useCallback, useMemo, useState } from 'react';
import { filterTreeIterative } from './filter-tree';
import { useDebouncedValue } from './use-debounced-value';

/**
 * A hook that provides debounced include/exclude filtering over a tree of IFileNode.
 */
export function useQuickFilter(fileTree: IFileNode[]) {
  const [quickFilter, setQuickFilter] = useState('');
  const debouncedFilter = useDebouncedValue(quickFilter, 150);

  const applyQuickFilter = useCallback((nodes: IFileNode[], filter: string): IFileNode[] => {
    if (!filter.trim()) {
      return nodes;
    }

    const { includes, excludes } = parseFilterString(filter);
    return filterTreeIterative(nodes, includes, excludes);
  }, []);

  const filteredTree = useMemo(
    () => applyQuickFilter(fileTree, debouncedFilter),
    [fileTree, debouncedFilter, applyQuickFilter]
  );

  const clearFilter = useCallback(() => {
    setQuickFilter('');
  }, []);

  return {
    clearFilter,
    filteredTree,
    quickFilter,
    setQuickFilter,
  };
}
