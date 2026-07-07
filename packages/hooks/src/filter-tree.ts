import type { IFileNode } from '@brainstrike/types';

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

export function filterTreeIterative(
  nodes: IFileNode[],
  includes: string[],
  excludes: string[]
): IFileNode[] {
  const result: IFileNode[] = [];

  interface Frame {
    node: IFileNode;
    parentChildren: IFileNode[];
    state: 'enter' | 'exit';
    tempChildren?: IFileNode[];
  }

  const stack: Frame[] = [];

  function pushChildren(node: IFileNode, parent: IFileNode[]): void {
    const childResults: IFileNode[] = [];
    stack.push({ node, parentChildren: parent, state: 'exit', tempChildren: childResults });
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) {
        stack.push({ node: child, parentChildren: childResults, state: 'enter' });
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
      stack.push({ node: item, parentChildren: result, state: 'enter' });
    }
  }

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      continue;
    }
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
