import type { IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { Minimatch } from 'minimatch';
import { fileNodeCollator } from './collator';
import { processFilter } from './filter-utils';

const logger = createLogger('TreeGenerator');

export function compilePatterns(patterns: string[], useRegex: boolean): (RegExp | Minimatch)[] {
  const processed = useRegex ? patterns : patterns.map(processFilter);
  const compiled: (RegExp | Minimatch)[] = [];
  for (const pattern of processed) {
    try {
      // dot:true keeps this matcher in lockstep with filter-utils and
      // hooks/filter-engine — view filters must see dotfiles.
      compiled.push(useRegex ? new RegExp(pattern) : new Minimatch(pattern, { dot: true }));
    } catch (error) {
      logger.error(`Invalid pattern: ${pattern}`, error);
    }
  }
  return compiled;
}

export function matchesPattern(path: string, patterns: (RegExp | Minimatch)[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  for (const pattern of patterns) {
    if (pattern instanceof RegExp) {
      if (pattern.test(path)) {
        return true;
      }
    } else if (pattern.match(path)) {
      return true;
    }
  }
  return false;
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

export function compareFileNodes(a: IFileNode, b: IFileNode): number {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1;
  }

  // Pre-compiled Intl.Collator is ~40x faster than inline localeCompare.
  // slice is much faster than regex replace for the common case of checking the first character.
  // toLowerCase is omitted because sensitivity: 'base' implies case-insensitivity.
  const nameA = a.name.charCodeAt(0) === 46 /* '.' */ ? a.name.slice(1) : a.name;
  const nameB = b.name.charCodeAt(0) === 46 /* '.' */ ? b.name.slice(1) : b.name;

  return fileNodeCollator.compare(nameA, nameB);
}

function sortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return [...nodes].sort(compareFileNodes);
}

function addNodeToLines(node: IFileNode, lines: string[]): void {
  const indentation = '  '.repeat(node.depth);
  lines.push(`${indentation}${node.name}${node.type === 'directory' ? '/' : ''}`);
}

function addSummaryLine(node: IFileNode, remainingCount: number, lines: string[]): void {
  const childIndentation = '  '.repeat(node.depth + 1);
  lines.push(
    `${childIndentation}... ${remainingCount} more ${remainingCount === 1 ? 'item' : 'items'}`
  );
}

function shouldIncludeFile(path: string, compiledInclude: (RegExp | Minimatch)[]): boolean {
  if (compiledInclude.length === 0) {
    return true;
  }
  return matchesPattern(path, compiledInclude);
}

function shouldIncludeDirectory(args: {
  path: string;
  hasVisibleChildren: boolean;
  compiledInclude: (RegExp | Minimatch)[];
}): boolean {
  if (args.compiledInclude.length === 0) {
    return true;
  }
  if (args.hasVisibleChildren) {
    return true;
  }
  return matchesPattern(args.path, args.compiledInclude);
}

function filterTreeNode(
  node: IFileNode,
  compiledInclude: (RegExp | Minimatch)[],
  compiledExclude: (RegExp | Minimatch)[]
): IFileNode | null {
  const path = normalizePath(node.path);

  if (matchesPattern(path, compiledExclude)) {
    return null;
  }

  if (node.type === 'file') {
    return shouldIncludeFile(path, compiledInclude) ? node : null;
  }

  const childNodes = node.children || [];
  const visibleChildren: IFileNode[] = [];

  for (const child of childNodes) {
    const filteredChild = filterTreeNode(child, compiledInclude, compiledExclude);
    if (filteredChild) {
      visibleChildren.push(filteredChild);
    }
  }

  if (
    !shouldIncludeDirectory({
      compiledInclude,
      hasVisibleChildren: visibleChildren.length > 0,
      path,
    })
  ) {
    return null;
  }

  // Sort children after filtering to reduce number of comparisons
  visibleChildren.sort(compareFileNodes);

  return {
    ...node,
    children: visibleChildren,
  };
}

function renderFilteredTree(
  node: IFileNode,
  lines: string[],
  folderSummaryThreshold: number
): void {
  addNodeToLines(node, lines);

  if (node.type !== 'directory' || !node.children || node.children.length === 0) {
    return;
  }

  const visibleChildren = node.children;
  if (folderSummaryThreshold > 0 && visibleChildren.length > folderSummaryThreshold) {
    for (const child of visibleChildren.slice(0, folderSummaryThreshold)) {
      renderFilteredTree(child, lines, folderSummaryThreshold);
    }
    const remainingCount = visibleChildren.length - folderSummaryThreshold;
    addSummaryLine(node, remainingCount, lines);
    return;
  }

  for (const child of visibleChildren) {
    renderFilteredTree(child, lines, folderSummaryThreshold);
  }
}

export function traverseFileTree(
  node: IFileNode,
  compiledInclude: (RegExp | Minimatch)[],
  compiledExclude: (RegExp | Minimatch)[],
  lines: string[],
  folderSummaryThreshold: number
): void {
  const filteredNode = filterTreeNode(node, compiledInclude, compiledExclude);
  if (!filteredNode) {
    return;
  }

  renderFilteredTree(filteredNode, lines, folderSummaryThreshold);
}

export function generateProjectTreeText(
  fileTree: IFileNode[],
  includeFilters: string[] = [],
  excludeFilters: string[] = [],
  useRegex = false,
  folderSummaryThreshold = 5
): string {
  const lines: string[] = [];
  const compiledInclude = compilePatterns(includeFilters, useRegex);
  const compiledExclude = compilePatterns(excludeFilters, useRegex);

  const sortedRootNodes = sortFileNodes(fileTree);

  for (const rootNode of sortedRootNodes) {
    traverseFileTree(rootNode, compiledInclude, compiledExclude, lines, folderSummaryThreshold);
  }

  return lines.join('\n');
}
