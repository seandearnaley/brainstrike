import type { ContextTarget } from '@brainstrike/context-actions';

export interface BrowserNodeDescriptor {
  content?: string;
  name?: string;
  /** The collection-browser node type discriminator ('collection' | 'file' | 'chunk' | 'embedding' | 'group'). */
  nodeType: string;
  /** Node id with the type prefix already stripped (collection-browser-view's parseNodeId). */
  originalId: string;
  path?: string | null;
  vectorId?: string;
}

export function browserNodeToTarget(descriptor: BrowserNodeDescriptor): ContextTarget | null {
  switch (descriptor.nodeType) {
    case 'collection':
      return { kind: 'collection', id: descriptor.originalId, name: descriptor.name ?? '' };
    case 'file':
      return {
        kind: 'collection-file',
        id: descriptor.originalId,
        name: descriptor.name ?? '',
        path: descriptor.path ?? null,
      };
    case 'chunk':
      return { kind: 'chunk', id: descriptor.originalId, content: descriptor.content ?? '' };
    case 'embedding':
      return {
        kind: 'embedding',
        id: descriptor.originalId,
        vectorId: descriptor.vectorId ?? descriptor.originalId,
      };
    default:
      return null;
  }
}
