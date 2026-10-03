import type { IFileNode } from '@brainstrike/types';

const NULL_BYTE_CONTENT_ERROR = 'File contains null bytes and cannot be indexed.';

export function getContentIndexingError(
  result:
    | { readonly content: string; readonly status: 'accessible' }
    | { readonly message: string; readonly status: 'inaccessible' }
): string | null {
  if (result.status === 'inaccessible') {
    return result.message;
  }
  if (result.content.includes('\0')) {
    return NULL_BYTE_CONTENT_ERROR;
  }
  return null;
}

export function flattenFileNodes(nodes: readonly IFileNode[]): IFileNode[] {
  const fileNodes: IFileNode[] = [];
  const pendingNodes: IFileNode[] = [];

  const pushInReverse = (candidates: readonly IFileNode[]): void => {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate) {
        pendingNodes.push(candidate);
      }
    }
  };

  pushInReverse(nodes);

  while (pendingNodes.length > 0) {
    const node = pendingNodes.pop();
    if (!node) {
      continue;
    }
    if (node.type === 'file') {
      fileNodes.push(node);
      continue;
    }
    if (node.children) {
      pushInReverse(node.children);
    }
  }

  return fileNodes;
}
