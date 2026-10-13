import type { SourceFileRecord } from '@brainstrike/types';

export type SourceImportIndexing =
  | { readonly kind: 'complete' }
  | { readonly kind: 'pending'; readonly reason: string };

export interface SourceChunkPage {
  readonly chunks: readonly {
    readonly chunkId: string;
    readonly content: string;
    readonly contentHash: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly chunkIndex: number | null;
    readonly chunkSize: number | null;
    readonly chunkType: string | null;
    readonly startOffset: number | null;
    readonly endOffset: number | null;
    readonly tokenCount: number | null;
    readonly vector: null | { readonly dimensions: number; readonly values: readonly number[] };
  }[];
  readonly contentHash: string;
  readonly fileId: string;
  readonly kind: 'available';
  readonly nextOffset: number | null;
  readonly profileHash: string | null;
  readonly snapshotHash: string;
  readonly total: number;
}
export interface SourceChunkRequest {
  readonly expected?: {
    readonly contentHash: string;
    readonly snapshotHash: string;
    readonly profileHash: string | null;
  };
  readonly fileId: string;
  readonly limit: number;
  readonly offset: number;
}

/** The visible Library's canonical source bytes; imported paths never establish filesystem authority. */
export interface SourceFilesCapability {
  chunks(
    request: SourceChunkRequest
  ): Promise<SourceChunkPage | { readonly kind: 'unavailable'; readonly reason: string }>;
  delete(fileIds: readonly string[]): Promise<void>;
  import(input: {
    readonly embeddingSetId: string | null;
    readonly files: readonly {
      readonly name: string;
      readonly path: string;
      readonly content: string;
      readonly size: number;
    }[];
  }): Promise<{
    readonly items: readonly { readonly file: SourceFileRecord; readonly imported: boolean }[];
    readonly indexing: SourceImportIndexing;
  }>;
  list(): Promise<readonly SourceFileRecord[]>;
  read(fileIds: readonly string[], maxContentBytes: number): Promise<readonly SourceFileRecord[]>;
}
