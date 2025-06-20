import type { IFileNode } from '@brainstrike/types';
import { parseFilterString } from '@brainstrike/utils';
import { useCallback, useMemo, useState } from 'react';
// New file: useQuickFilter hook
import { useDebouncedValue } from './use-debounced-value';

function createSearchableText(node: IFileNode): string {
  return [node.name.toLowerCase(), node.path.toLowerCase()].join(' ');
}

function isNodeExcluded(searchableText: string, excludes: string[]): boolean {
  return excludes.some((exclude) => searchableText.includes(exclude));
}

function isNodeIncluded(searchableText: string, includes: string[]): boolean {
  return includes.length === 0 || includes.some((include) => searchableText.includes(include));
}

function processDirectoryNode(
  node: IFileNode,
  isIncluded: boolean,
  filteredChildren: IFileNode[]
): IFileNode | null {
  if (filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }
  if (isIncluded) {
    return { ...node, children: [] };
  }
  return null;
}

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
        const searchableText = createSearchableText(node);

        if (isNodeExcluded(searchableText, excludes)) {
          return null;
        }

        const isIncluded = isNodeIncluded(searchableText, includes);

        if (node.type === 'directory' && node.children) {
          const filteredChildren = applyQuickFilter(node.children, filter);
          return processDirectoryNode(node, isIncluded, filteredChildren);
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
