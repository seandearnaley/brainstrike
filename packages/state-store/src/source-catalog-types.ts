/** Authoritative source metadata; native indexes contain only rebuildable projections. */
import type { SourceFileRecord } from '@brainstrike/types';
export type SourceCatalogRecord = SourceFileRecord;
export interface SourceCatalogInput {
  readonly content: string;
  readonly contentHash: string;
  readonly fileName: string;
  readonly path: string;
  readonly stat: SourceCatalogRecord['stat'];
}
export type SourceCatalogRequest =
  | { readonly operation: 'list' }
  | { readonly operation: 'inventory'; readonly embeddingSetId: string | null }
  | {
      readonly operation: 'read';
      readonly fileIds: readonly string[];
      readonly maxContentBytes?: number;
    }
  | {
      readonly operation: 'import';
      readonly embeddingSetId: string | null;
      readonly files: readonly SourceCatalogInput[];
    }
  | {
      readonly operation: 'prepare';
      readonly rootId: string;
      readonly embeddingSetId: string | null;
      readonly files: readonly SourceCatalogInput[];
    }
  | {
      readonly operation: 'replace';
      readonly files: readonly {
        readonly expected: SourceCatalogRecord;
        readonly source: SourceCatalogInput;
      }[];
    }
  | {
      readonly operation: 'complete';
      readonly files: readonly {
        readonly expected: SourceCatalogRecord;
        readonly chunkCount: number;
      }[];
    }
  | { readonly operation: 'remove'; readonly files: readonly SourceCatalogRecord[] };
export interface SourceCatalogReply {
  readonly files: readonly SourceCatalogRecord[];
  /** Per-input commit receipt, present only for import. */
  readonly imported?: readonly boolean[];
}
export interface SourceCatalogPort {
  sourceCatalog(request: SourceCatalogRequest): Promise<SourceCatalogReply>;
}
