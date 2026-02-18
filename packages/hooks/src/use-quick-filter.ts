import type { IFileNode } from '@brainstrike/types';
import { parseFilterString } from '@brainstrike/utils';
import { useCallback, useMemo, useState } from 'react';
import { useDebouncedValue } from './use-debounced-value';
import { filterTreeIterative } from './quick-filter-engine';

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
    quickFilter,
    setQuickFilter,
    filteredTree,
    clearFilter,
  };
}
