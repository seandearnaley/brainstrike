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

function filterTreeIterative(
  nodes: IFileNode[],
  includes: string[],
  excludes: string[]
): IFileNode[] {
  const result: IFileNode[] = [];

  interface Frame {
    node: IFileNode;
    state: 'enter' | 'exit';
    parentChildren: IFileNode[];
    tempChildren?: IFileNode[];
  }

  const stack: Frame[] = [];

  function pushChildren(node: IFileNode, parent: IFileNode[]): void {
    const childResults: IFileNode[] = [];
    stack.push({ node, state: 'exit', parentChildren: parent, tempChildren: childResults });
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) {
        stack.push({ node: child, state: 'enter', parentChildren: childResults });
      }
    }
  }

  function handleFile(frame: Frame): void {
    const searchable = createSearchableText(frame.node);
    if (!isNodeExcluded(searchable, excludes) && isNodeIncluded(searchable, includes)) {
      frame.parentChildren.push(frame.node);
    }
  }

  function handleExit(frame: Frame): void {
    const searchable = createSearchableText(frame.node);
    if (isNodeExcluded(searchable, excludes)) {
      return;
    }

    const included = isNodeIncluded(searchable, includes);
    const processed = processDirectoryNode(frame.node, included, frame.tempChildren ?? []);
    if (processed) {
      frame.parentChildren.push(processed);
    }
  }

  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const item = nodes[i];
    if (item) {
      stack.push({ node: item, state: 'enter', parentChildren: result });
    }
  }

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.state === 'enter') {
      if (frame.node.type === 'directory' && frame.node.children) {
        pushChildren(frame.node, frame.parentChildren);
      } else {
        handleFile(frame);
      }
    } else {
      handleExit(frame);
    }
  }

  return result;
}

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
