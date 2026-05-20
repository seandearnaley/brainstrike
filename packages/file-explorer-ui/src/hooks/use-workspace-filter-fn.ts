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
import type { IFileNode } from '@brainstrike/types';
import { useCallback } from 'react';
import { useFileExplorerStoreSelector } from '../shell/file-explorer-provider';
import {
  selectExcludeFilters,
  selectIncludeFilters,
  selectUseRegex,
} from '../utils/workspace-filter-selectors';

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
  const includeFilters = useFileExplorerStoreSelector(selectIncludeFilters);
  const excludeFilters = useFileExplorerStoreSelector(selectExcludeFilters);
  const useRegex = useFileExplorerStoreSelector(selectUseRegex);

  // Get the filter implementation
  const { applyFileFilters } = useFileFilters();

  // Create memoized filter function
  const filterTreeFn = useCallback(
    (tree: IFileNode[]) => applyFileFilters(tree, includeFilters, excludeFilters, useRegex),
    [applyFileFilters, includeFilters, excludeFilters, useRegex]
  );

  return filterTreeFn;
}
