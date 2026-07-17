import type { IFileNode } from '@brainstrike/types';
import { processFilter } from '@brainstrike/utils/filter-utils';
import { useCallback, useRef, useState } from 'react';
import {
  arraysEqual,
  createFilterFunctions,
  createProcessTreeFunction,
  type PatternCache,
  setupFilters,
} from './filter-engine';

interface RegexCache extends PatternCache {
  lastExcludePatterns: string[];
  lastIncludePatterns: string[];
  lastUseRegex: boolean;
}

function updateRegexCacheIfNeeded(
  regexCache: React.RefObject<RegexCache>,
  processedIncludeFilters: string[],
  processedExcludeFilters: string[],
  useRegex: boolean,
  setError: (msg: string) => void
): boolean {
  const patternsChanged =
    regexCache.current.lastUseRegex !== useRegex ||
    !arraysEqual(regexCache.current.lastIncludePatterns, processedIncludeFilters) ||
    !arraysEqual(regexCache.current.lastExcludePatterns, processedExcludeFilters);

  if (!patternsChanged) {
    return true;
  }

  const success = setupFilters(
    useRegex ? 'regex' : 'glob',
    processedIncludeFilters,
    processedExcludeFilters,
    regexCache.current,
    setError
  );

  if (!success) {
    return false;
  }

  regexCache.current.lastIncludePatterns = processedIncludeFilters;
  regexCache.current.lastExcludePatterns = processedExcludeFilters;
  regexCache.current.lastUseRegex = useRegex;
  return true;
}

/**
 * A hook that applies include/exclude filters (glob or regex) to a tree of IFileNode.
 * Features:
 * - Regex pattern caching to avoid recompilation when patterns haven't changed
 * - Efficient tree filtering with early exclusion checks
 *
 * @returns applyFileFilters: function to filter a node tree, and filterError: error message if regex is invalid
 */
export function useFileFilters() {
  const regexCache = useRef<RegexCache>({
    excludeGlobs: [],
    excludeRegex: [],
    includeGlobs: [],
    includeRegex: [],
    lastExcludePatterns: [],
    lastIncludePatterns: [],
    lastUseRegex: false,
  });
  const [filterError, setFilterError] = useState<string | null>(null);
  const filterErrorRef = useRef(filterError);
  filterErrorRef.current = filterError;

  const applyFileFilters = useCallback(
    (
      fileTree: IFileNode[],
      includeFilters: string[],
      excludeFilters: string[] = [],
      useRegex = false
    ): IFileNode[] => {
      // Only clear error if there was one, to avoid unnecessary state updates
      if (filterErrorRef.current !== null) {
        setFilterError(null);
      }

      const processedIncludeFilters = useRegex ? includeFilters : includeFilters.map(processFilter);
      const processedExcludeFilters = useRegex ? excludeFilters : excludeFilters.map(processFilter);
      const hasNoFilters =
        processedIncludeFilters.length === 0 && processedExcludeFilters.length === 0;

      // Critical fast path for large trees: avoid cloning/traversing when no filters are active.
      // Returning the original tree keeps folder switching and preset toggles responsive.
      if (hasNoFilters) {
        return fileTree;
      }

      // Update regex cache if needed
      const cacheSuccess = updateRegexCacheIfNeeded(
        regexCache,
        processedIncludeFilters,
        processedExcludeFilters,
        useRegex,
        setFilterError
      );

      if (!cacheSuccess) {
        return [];
      }

      const { matchesInclude, matchesExclude } = createFilterFunctions(
        regexCache.current,
        useRegex
      );

      const processTree = createProcessTreeFunction(matchesInclude, matchesExclude);

      return processTree(fileTree);
    },
    []
  );

  return { applyFileFilters, filterError };
}
