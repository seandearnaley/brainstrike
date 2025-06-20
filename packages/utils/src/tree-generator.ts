import type { IFileNode } from '@brainstrike/types';
import { Minimatch } from 'minimatch';
import { processFilter } from './filter-utils';
import { createLogger } from './logger';

const logger = createLogger('TreeGenerator');

export function compilePatterns(patterns: string[], useRegex: boolean): (RegExp | Minimatch)[] {
  const processed = useRegex ? patterns : patterns.map(processFilter);
  const compiled: (RegExp | Minimatch)[] = [];
  for (const pattern of processed) {
    try {
      compiled.push(useRegex ? new RegExp(pattern) : new Minimatch(pattern));
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

function sortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }

    const nameA = a.name.replace(/^\./, '').toLowerCase();
    const nameB = b.name.replace(/^\./, '').toLowerCase();
    return nameA.localeCompare(nameB, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function shouldIncludeNode(node: IFileNode, compiledInclude: (RegExp | Minimatch)[]): boolean {
  if (node.type === 'directory') {
    return true;
  }

  if (compiledInclude.length === 0) {
    return true;
  }

  return false;
}

function addNodeToLines(node: IFileNode, lines: string[]): void {
  const indentation = '  '.repeat(node.depth);
  lines.push(`${indentation}${node.name}${node.type === 'directory' ? '/' : ''}`);
}

function getVisibleChildren(
  children: IFileNode[],
  compiledExclude: (RegExp | Minimatch)[]
): IFileNode[] {
  const sortedChildren = sortFileNodes(children);
  return sortedChildren.filter((child) => {
    const childPath = child.path.startsWith('/') ? child.path.slice(1) : child.path;
    return !matchesPattern(childPath, compiledExclude);
  });
}

function addSummaryLine(node: IFileNode, remainingCount: number, lines: string[]): void {
  const childIndentation = '  '.repeat(node.depth + 1);
  lines.push(
    `${childIndentation}... ${remainingCount} more ${remainingCount === 1 ? 'item' : 'items'}`
  );
}

function processDirectoryChildren(
  node: IFileNode,
  visibleChildren: IFileNode[],
  compiledInclude: (RegExp | Minimatch)[],
  compiledExclude: (RegExp | Minimatch)[],
  lines: string[],
  folderSummaryThreshold: number
): void {
  if (folderSummaryThreshold > 0 && visibleChildren.length > folderSummaryThreshold) {
    for (const child of visibleChildren.slice(0, folderSummaryThreshold)) {
      traverseFileTree(child, compiledInclude, compiledExclude, lines, folderSummaryThreshold);
    }
    const remainingCount = visibleChildren.length - folderSummaryThreshold;
    addSummaryLine(node, remainingCount, lines);
  } else {
    for (const child of visibleChildren) {
      traverseFileTree(child, compiledInclude, compiledExclude, lines, folderSummaryThreshold);
    }
  }
}

export function traverseFileTree(
  node: IFileNode,
  compiledInclude: (RegExp | Minimatch)[],
  compiledExclude: (RegExp | Minimatch)[],
  lines: string[],
  folderSummaryThreshold: number
): void {
  const path = node.path.startsWith('/') ? node.path.slice(1) : node.path;

  if (matchesPattern(path, compiledExclude)) {
    return;
  }

  const includeNode =
    shouldIncludeNode(node, compiledInclude) ||
    (node.type === 'file' && matchesPattern(path, compiledInclude));

  if (includeNode) {
    addNodeToLines(node, lines);
  }

  if (node.type === 'directory' && node.children) {
    const visibleChildren = getVisibleChildren(node.children, compiledExclude);
    processDirectoryChildren(
      node,
      visibleChildren,
      compiledInclude,
      compiledExclude,
      lines,
      folderSummaryThreshold
    );
  }
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
