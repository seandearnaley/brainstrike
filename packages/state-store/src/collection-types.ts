import type { CollectionMetadata, CollectionRecord } from '@brainstrike/types';

export type { CollectionMetadata, CollectionRecord } from '@brainstrike/types';
export type CollectionRequest =
  | { readonly operation: 'list' }
  | { readonly operation: 'snapshot' }
  | { readonly operation: 'get'; readonly id: string }
  | { readonly operation: 'create'; readonly collection: CollectionRecord }
  | { readonly operation: 'update'; readonly id: string; readonly metadata: CollectionMetadata }
  | { readonly operation: 'delete'; readonly id: string };
export interface CollectionReply {
  readonly collections: readonly CollectionRecord[];
  readonly counts?: readonly {
    readonly id: string;
    readonly files: number;
    readonly chunks: number;
    readonly unprocessedFiles: number;
  }[];
}
export interface CollectionPort {
  collections(request: CollectionRequest): Promise<CollectionReply>;
}
