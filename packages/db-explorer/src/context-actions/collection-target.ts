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
      return { id: descriptor.originalId, kind: 'collection', name: descriptor.name ?? '' };
    case 'file':
      return {
        id: descriptor.originalId,
        kind: 'collection-file',
        name: descriptor.name ?? '',
        path: descriptor.path ?? null,
      };
    case 'chunk':
      return { content: descriptor.content ?? '', id: descriptor.originalId, kind: 'chunk' };
    case 'embedding':
      return {
        id: descriptor.originalId,
        kind: 'embedding',
        vectorId: descriptor.vectorId ?? descriptor.originalId,
      };
    default:
      return null;
  }
}
