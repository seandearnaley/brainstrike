/** Browser-safe DTOs only. Native process ownership belongs to @brainstrike/indexer. */
export interface IndexerEmbeddingProfile {
  readonly dimensions: number;
  readonly dtype: 'q8' | 'fp16' | 'fp32';
  readonly modelId: string;
  readonly revision: string;
  readonly tokenCap: number;
}
export type IndexerEmbeddingState =
  | { readonly indexMode: 'text-only' }
  | {
      readonly indexMode: 'vector-configured';
      readonly profile: IndexerEmbeddingProfile;
      readonly profileHash: string;
    };
export interface IndexerRootReadiness {
  readonly rootId: string;
  /** Receipt from the canonical producer's complete scan, never inferred from row counts. */
  readonly scanComplete: boolean;
}
export type IndexerStatus =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | {
      readonly kind: 'ready';
      readonly embedding: IndexerEmbeddingState;
      readonly storeId: string;
      readonly authorizedRootIds: readonly string[];
      readonly authorizedCollectionIds?: readonly string[];
      readonly collectionReadiness?: readonly {
        readonly embeddingSetId: string;
        readonly scanComplete: boolean;
      }[];
      readonly queryPlan?: {
        readonly modelKey: string;
        readonly inferencePlan: {
          readonly modelId: string;
          readonly revision: string;
          readonly dimensions: 384;
          readonly dtype: 'q8' | 'fp16' | 'fp32';
          readonly device: 'wasm' | 'webgpu';
        };
      };
      readonly rootReadiness: readonly IndexerRootReadiness[];
    };
export interface IndexerCoverageRequest {
  readonly collectionId?: string;
  readonly rootIds: readonly string[];
}
export interface IndexerCoverageCounts {
  readonly chunks: number;
  readonly indexedFiles: number;
  readonly missingVectors: number;
  readonly vectors: number;
}
export interface IndexerCoverage {
  readonly collections?: readonly (IndexerCoverageCounts & { readonly embeddingSetId: string })[];
  readonly embedding: IndexerEmbeddingState;
  readonly roots: readonly (IndexerCoverageCounts & { readonly rootId: string })[];
  readonly storeId: string;
  readonly totals: IndexerCoverageCounts;
  /** Complete vector coverage of nonempty indexed rows; does not establish complete root scans. */
  readonly vectorCoverageComplete: boolean;
}
export type IndexerSearchRequest = {
  readonly collectionId?: string;
  readonly rootIds: readonly string[];
  readonly limit: number;
} & (
  | { readonly mode: 'bm25' | 'trigram'; readonly text: string }
  | {
      readonly mode: 'vector';
      readonly profile: IndexerEmbeddingProfile;
      readonly vector: readonly number[];
    }
);
export interface IndexerSearchHit {
  readonly chunkId: string;
  readonly chunkIndex: number | null;
  readonly chunkSize: number | null;
  readonly chunkType: 'text' | 'sentence' | 'recursive' | null;
  readonly content: string;
  readonly contentHash: string;
  readonly embeddingSetId?: string | null;
  readonly endLine: number;
  readonly endOffset: number | null;
  readonly fileId: string;
  readonly relativePath: string | null;
  readonly rootId: string | null;
  readonly score: number;
  readonly sourcePath?: string | null;
  readonly startLine: number;
  readonly startOffset: number | null;
  readonly tokenCount: number | null;
}
export interface IndexerSearchResult {
  readonly candidateCount: number;
  readonly candidatesTruncated: boolean;
  readonly embedding: IndexerEmbeddingState;
  readonly hits: readonly IndexerSearchHit[];
  readonly scanLimited: boolean;
  readonly storeId: string;
  readonly truncated: boolean;
}
export interface IndexerGrepRequest {
  readonly caseSensitive: boolean;
  readonly collectionId?: string;
  readonly isRegex: boolean;
  readonly limit: number;
  readonly pattern: string;
  readonly rootIds: readonly string[];
}
export interface IndexerGrepResult extends IndexerSearchResult {
  readonly candidatesTruncated: boolean;
  readonly scanLimited: boolean;
  readonly truncated: boolean;
}
export interface IndexerCoverageBatch {
  /** Results preserve request order and independent scope counters. */
  readonly coverage: readonly IndexerCoverage[];
  /** Canonical readiness from the same before/after fenced observation as coverage. */
  readonly status: Extract<IndexerStatus, { kind: 'ready' }>;
}
export interface IndexSearchCapability {
  coverage(request: IndexerCoverageRequest): Promise<IndexerCoverage>;
  coverageBatch(requests: readonly IndexerCoverageRequest[]): Promise<IndexerCoverageBatch>;
  /** Separate killable read-only host; never runs regex in the writer owner. */
  grep(request: IndexerGrepRequest): Promise<IndexerGrepResult>;
  /** Retires and rebuilds only the derived SQLite index; preserves application data and saved choices. */
  rebuild(): Promise<void>;
  search(request: IndexerSearchRequest): Promise<IndexerSearchResult>;
  status(): Promise<IndexerStatus>;
}
