import type { IFileNode } from '@brainstrike/types';
import { processFilter } from '@brainstrike/utils';
import { Minimatch } from 'minimatch';
import { useCallback, useRef, useState } from 'react';

function compileRegexPatterns(
  patterns: string[],
  setError: (msg: string) => void
): RegExp[] | null {
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      regexes.push(new RegExp(pattern));
    } catch {
      setError(`Invalid regex pattern: ${pattern}`);
      return null;
    }
  }
  return regexes;
}

function compileGlobPatterns(patterns: string[]): Minimatch[] {
  return patterns.map((pattern) => new Minimatch(pattern));
}

function matchPath(
  path: string,
  regexes: RegExp[],
  globMatchers: Minimatch[],
  useRegex: boolean
): boolean {
  if (useRegex) {
    return regexes.some((regex) => regex.test(path));
  }
  return globMatchers.some((matcher) => matcher.match(path));
}

function cloneNode(node: IFileNode, keepChildren: boolean): IFileNode {
  const newNode: IFileNode = { ...node, isVisible: true };
  if (node.children && keepChildren) {
    newNode.children = [...node.children];
  } else if (node.children) {
    newNode.children = [];
  }
  return newNode;
}

function normalizeNodePath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function processDirectoryNode(
  node: IFileNode,
  processTree: (nodes: IFileNode[]) => IFileNode[]
): IFileNode {
  const cloned = cloneNode(node, false);
  if (node.children && node.children.length > 0) {
    cloned.children = processTree(node.children);
  }
  return cloned;
}

function processFileNode(
  node: IFileNode,
  path: string,
  matchesInclude: (path: string) => boolean
): IFileNode | null {
  if (matchesInclude(path)) {
    return cloneNode(node, true);
  }
  return null;
}

function setupRegexFilters(
  processedIncludeFilters: string[],
  processedExcludeFilters: string[],
  patternCache: React.MutableRefObject<{
    includeRegex: RegExp[];
    excludeRegex: RegExp[];
    includeGlobs: Minimatch[];
    excludeGlobs: Minimatch[];
  }>,
  setError: (msg: string) => void
): boolean {
  const includes = compileRegexPatterns(processedIncludeFilters, setError);
  if (!includes) {
    return false;
  }

  const excludes = compileRegexPatterns(processedExcludeFilters, setError);
  if (!excludes) {
    return false;
  }

  patternCache.current.includeRegex = includes;
  patternCache.current.excludeRegex = excludes;
  patternCache.current.includeGlobs = [];
  patternCache.current.excludeGlobs = [];
  return true;
}

function setupGlobFilters(
  processedIncludeFilters: string[],
  processedExcludeFilters: string[],
  patternCache: React.MutableRefObject<{
    includeRegex: RegExp[];
    excludeRegex: RegExp[];
    includeGlobs: Minimatch[];
    excludeGlobs: Minimatch[];
  }>,
  setError: (msg: string) => void
): boolean {
  try {
    patternCache.current.includeGlobs = compileGlobPatterns(processedIncludeFilters);
    patternCache.current.excludeGlobs = compileGlobPatterns(processedExcludeFilters);
    patternCache.current.includeRegex = [];
    patternCache.current.excludeRegex = [];
    return true;
  } catch {
    setError('Invalid glob pattern');
    return false;
  }
}

function createFilterFunctions(
  patternCache: React.MutableRefObject<{
    includeRegex: RegExp[];
    excludeRegex: RegExp[];
    includeGlobs: Minimatch[];
    excludeGlobs: Minimatch[];
  }>,
  useRegex: boolean
) {
  const matchesInclude = (path: string): boolean => {
    if (
      useRegex
        ? patternCache.current.includeRegex.length === 0
        : patternCache.current.includeGlobs.length === 0
    ) {
      return true;
    }
    return matchPath(
      path,
      patternCache.current.includeRegex,
      patternCache.current.includeGlobs,
      useRegex
    );
  };

  const matchesExclude = (path: string): boolean =>
    matchPath(path, patternCache.current.excludeRegex, patternCache.current.excludeGlobs, useRegex);

  return { matchesInclude, matchesExclude };
}

function createProcessTreeFunction(
  matchesInclude: (path: string) => boolean,
  matchesExclude: (path: string) => boolean
) {
  const processTree = (nodes: IFileNode[]): IFileNode[] => {
    const result: IFileNode[] = [];
    for (const node of nodes) {
      const path = normalizeNodePath(node.path);
      if (matchesExclude(path)) {
        continue;
      }

      if (node.type === 'directory') {
        result.push(processDirectoryNode(node, processTree));
      } else if (node.type === 'file') {
        const processedFile = processFileNode(node, path, matchesInclude);
        if (processedFile) {
          result.push(processedFile);
        }
      }
    }
    return result;
  };

  return processTree;
}

/**
 * Checks if two string arrays are equal (same length and same elements in order).
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

type RegexCacheRef = React.MutableRefObject<{
  includeRegex: RegExp[];
  excludeRegex: RegExp[];
  includeGlobs: Minimatch[];
  excludeGlobs: Minimatch[];
  lastIncludePatterns: string[];
  lastExcludePatterns: string[];
  lastUseRegex: boolean;
}>;

/**
 * Checks if regex patterns need recompilation and updates the cache if so.
 * Returns false if compilation fails (error is set via setError).
 */
function updateRegexCacheIfNeeded(
  regexCache: RegexCacheRef,
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

  let success = true;
  if (useRegex) {
    success = setupRegexFilters(
      processedIncludeFilters,
      processedExcludeFilters,
      regexCache,
      setError
    );
  } else {
    success = setupGlobFilters(
      processedIncludeFilters,
      processedExcludeFilters,
      regexCache,
      setError
    );
  }

  if (!success) {
    return false;
  }

  // Update cache tracking
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
  const regexCache = useRef<{
    includeRegex: RegExp[];
    excludeRegex: RegExp[];
    includeGlobs: Minimatch[];
    excludeGlobs: Minimatch[];
    // Track last used patterns to detect changes
    lastIncludePatterns: string[];
    lastExcludePatterns: string[];
    lastUseRegex: boolean;
  }>({
    includeRegex: [],
    excludeRegex: [],
    includeGlobs: [],
    excludeGlobs: [],
    lastIncludePatterns: [],
    lastExcludePatterns: [],
    lastUseRegex: false,
  });
  const [filterError, setFilterError] = useState<string | null>(null);

  const applyFileFilters = useCallback(
    (
      fileTree: IFileNode[],
      includeFilters: string[],
      excludeFilters: string[] = [],
      useRegex = false
    ): IFileNode[] => {
      // Only clear error if there was one, to avoid unnecessary state updates
      if (filterError !== null) {
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

      const { matchesInclude, matchesExclude } = createFilterFunctions(regexCache, useRegex);

      const processTree = createProcessTreeFunction(matchesInclude, matchesExclude);

      return processTree(fileTree);
    },
    [filterError]
  );

  return { applyFileFilters, filterError };
}
