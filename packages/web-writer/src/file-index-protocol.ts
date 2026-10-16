import type { IndexFileBinding, IndexScope } from '@brainstrike/indexer';

/** What the file index is authorized for: the writer's live roots, its collections and their files. */
export interface FileIndexAuthority {
  readonly fileBindings: readonly IndexFileBinding[];
  readonly rootIds: readonly string[];
  readonly scopes: readonly IndexScope[];
}

/** The writer's messages to the file index worker. */
export type FileIndexRequest =
  | {
      readonly authority: FileIndexAuthority;
      readonly id: number;
      readonly kind: 'open';
      readonly pool: string;
      readonly vfs: string;
    }
  | { readonly authority: FileIndexAuthority; readonly id: number; readonly kind: 'reauthorize' }
  | { readonly id: number; readonly kind: 'request'; readonly op: string; readonly params: unknown }
  | { readonly id: number; readonly kind: 'close' };

export type FileIndexReply =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly error: { readonly code: unknown; readonly message: string; readonly name: string };
      readonly id: number;
      readonly ok: false;
    };
