import type { ChunkResult } from '@brainstrike/chunking-worker';

export interface CanonicalChunkSource {
  readonly content: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly fileRecordId: string;
}
export type CanonicalChunkEvent =
  | { readonly kind: 'empty-source'; readonly source: CanonicalChunkSource }
  | {
      readonly kind: 'worker-result';
      readonly source: CanonicalChunkSource;
      readonly result: ChunkResult;
    };
/** Explicit text policy. Sources come from the existing import batch, never another read or walk. */
export interface CanonicalTextChunkProducer {
  commit(event: CanonicalChunkEvent): Promise<void>;
  sourceForFile(fileRecordId: string): Promise<CanonicalChunkSource>;
}
