import type { IFileNode } from '@brainstrike/types';
import { Minimatch } from 'minimatch';

export function compileRegexPatterns(
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

export function compileGlobPatterns(patterns: string[]): Minimatch[] {
  // dot:true — the tree display must see dotfiles, in lockstep with the scan
  // matcher (utils/filter-utils createPathFilterMatcher). Without it the
  // "All Files" preset (include '*') hides every dot-path.
  return patterns.map((pattern) => new Minimatch(pattern, { dot: true }));
}

export function matchPath(
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

export function normalizeNodePath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function processDirectoryNode(
  node: IFileNode,
  processTree: (nodes: IFileNode[]) => IFileNode[]
): IFileNode | null {
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

export interface PatternCache {
  excludeGlobs: Minimatch[];
  excludeRegex: RegExp[];
  includeGlobs: Minimatch[];
  includeRegex: RegExp[];
}

export function setupFilters(
  mode: 'regex' | 'glob',
  processedIncludeFilters: string[],
  processedExcludeFilters: string[],
  cache: PatternCache,
  setError: (msg: string) => void
): boolean {
  if (mode === 'regex') {
    const includes = compileRegexPatterns(processedIncludeFilters, setError);
    if (!includes) {
      return false;
    }

    const excludes = compileRegexPatterns(processedExcludeFilters, setError);
    if (!excludes) {
      return false;
    }

    cache.includeRegex = includes;
    cache.excludeRegex = excludes;
    cache.includeGlobs = [];
    cache.excludeGlobs = [];
    return true;
  }

  try {
    cache.includeGlobs = compileGlobPatterns(processedIncludeFilters);
    cache.excludeGlobs = compileGlobPatterns(processedExcludeFilters);
    cache.includeRegex = [];
    cache.excludeRegex = [];
    return true;
  } catch {
    setError('Invalid glob pattern');
    return false;
  }
}

export function createFilterFunctions(
  cache: PatternCache,
  useRegex: boolean
): {
  matchesInclude: (path: string) => boolean;
  matchesExclude: (path: string) => boolean;
} {
  const matchesInclude = (path: string): boolean => {
    if (useRegex ? cache.includeRegex.length === 0 : cache.includeGlobs.length === 0) {
      return true;
    }
    return matchPath(path, cache.includeRegex, cache.includeGlobs, useRegex);
  };

  const matchesExclude = (path: string): boolean =>
    matchPath(path, cache.excludeRegex, cache.excludeGlobs, useRegex);

  return { matchesExclude, matchesInclude };
}

export function createProcessTreeFunction(
  matchesInclude: (path: string) => boolean,
  matchesExclude: (path: string) => boolean
): (nodes: IFileNode[]) => IFileNode[] {
  const processTree = (nodes: IFileNode[]): IFileNode[] => {
    const result: IFileNode[] = [];
    for (const node of nodes) {
      const path = normalizeNodePath(node.path);
      if (matchesExclude(path)) {
        continue;
      }

      if (node.type === 'directory') {
        const processedDirectory = processDirectoryNode(node, processTree);
        if (processedDirectory) {
          result.push(processedDirectory);
        }
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

export function arraysEqual(a: string[], b: string[]): boolean {
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
