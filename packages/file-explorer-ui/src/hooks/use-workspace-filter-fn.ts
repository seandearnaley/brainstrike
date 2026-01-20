/**
 * Workspace Filter Function Hook
 *
 * Creates a memoized filter function that applies workspace include/exclude
 * filters to a file tree. Used by FileTreeProvider to ensure workspace filters
 * are respected in the slow path of selectAllRecursively.
 *
 * @module use-workspace-filter-fn
 */

import { useFileFilters } from '@brainstrike/hooks';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { useCallback } from 'react';
import { useFileExplorerStoreContext } from '../file-explorer-provider';

/**
 * Hook that returns a memoized filter function for applying workspace filters.
 *
 * This hook:
 * 1. Accesses the current workspace filter settings from the store
 * 2. Uses useFileFilters to get the filter implementation
 * 3. Returns a memoized callback that applies filters to a tree
 *
 * @returns A function that takes a tree and returns the filtered tree
 */
export function useWorkspaceFilterFn(): (tree: IFileNode[]) => IFileNode[] {
  // Get filter settings from store
  const selectIncludeFilters = (s: FileExplorerState) => s.includeFilters;
  const selectExcludeFilters = (s: FileExplorerState) => s.excludeFilters;
  const selectUseRegex = (s: FileExplorerState) => s.useRegex;

  const store = useFileExplorerStoreContext();
  const includeFilters = store(selectIncludeFilters);
  const excludeFilters = store(selectExcludeFilters);
  const useRegex = store(selectUseRegex);

  // Get the filter implementation
  const { applyFileFilters } = useFileFilters();

  // Create memoized filter function
  const filterTreeFn = useCallback(
    (tree: IFileNode[]) => applyFileFilters(tree, includeFilters, excludeFilters, useRegex),
    [applyFileFilters, includeFilters, excludeFilters, useRegex]
  );

  return filterTreeFn;
}
