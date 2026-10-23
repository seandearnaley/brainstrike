import type { CollectionRecord } from '@brainstrike/types';

export type { CollectionMetadata, CollectionRecord } from '@brainstrike/types';
export type CollectionRequest =
  | { readonly operation: 'list' }
  | { readonly operation: 'get'; readonly id: string }
  | { readonly operation: 'create'; readonly collection: CollectionRecord }
  | { readonly operation: 'delete'; readonly id: string };
export interface CollectionReply {
  readonly collections: readonly CollectionRecord[];
}
export interface CollectionPort {
  collections(request: CollectionRequest): Promise<CollectionReply>;
}
