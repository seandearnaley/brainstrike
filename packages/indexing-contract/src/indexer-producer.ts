import type {
  IndexerEmbeddingProfile,
  IndexerEmbeddingState,
  IndexerRootReadiness,
  IndexerStatus,
} from './indexer-client.ts';
import type {
  IndexerCommitResult,
  IndexerFileSyntax,
  IndexerManifestFile,
  IndexerManifestRequest,
  IndexerProvidedChunk,
} from './indexer-producer-schema.ts';

export type {
  IndexerCommitResult,
  IndexerFileSyntax,
  IndexerManifestFile,
  IndexerManifestRequest,
  IndexerProvidedChunk,
};

/** Browser-safe write DTOs. Database paths, process policy and SQL stay in the main owner. */
export interface IndexerIdentity {
  readonly embedding: IndexerEmbeddingState;
  readonly storeId: string;
}
export interface IndexerManifestResult extends IndexerIdentity {
  readonly changed: readonly IndexerManifestFile[];
  readonly complete: boolean;
  readonly missing: readonly IndexerManifestFile[];
  readonly rootId: string;
  readonly unexpected: readonly IndexerManifestFile[];
}
export interface IndexerCanonicalSnapshot {
  readonly content: string;
  readonly fileId: string;
  readonly providedChunks: readonly IndexerProvidedChunk[];
  readonly relativePath: string;
  readonly rootId: string;
}
export interface IndexerTextPublication extends IndexerCanonicalSnapshot {
  readonly scanTicket?: IndexerScanTicket;
  readonly syntax?: IndexerFileSyntax;
}
export interface IndexerVectorPlan extends IndexerIdentity {
  readonly chunks: readonly (IndexerProvidedChunk & {
    readonly chunkId: string;
    readonly embeddingHash: string | null;
  })[];
  readonly contentHash: string;
  readonly embedding: Extract<IndexerEmbeddingState, { readonly indexMode: 'vector-configured' }>;
  readonly embeddingChunkIds: readonly string[];
  readonly previousSnapshotHash: string | null;
  readonly snapshot: IndexerCanonicalSnapshot;
  readonly unchanged: boolean;
}
export interface IndexerVectorPreparation {
  readonly profile: IndexerEmbeddingProfile;
  readonly snapshot: IndexerCanonicalSnapshot;
}
export interface IndexerVectorPublication {
  readonly embeddings: readonly { readonly chunkId: string; readonly vector: readonly number[] }[];
  readonly plan: IndexerVectorPlan;
  readonly profile: IndexerEmbeddingProfile;
  readonly scanTicket?: IndexerScanTicket;
  readonly syntax?: IndexerFileSyntax;
}
export interface IndexerScanStart {
  readonly mode: 'full' | 'paths';
  readonly rootId: string;
  readonly scanId: string;
}
export interface IndexerScanTicket extends IndexerScanStart {
  readonly generation: number;
  readonly storeId: string;
}
export interface IndexerScanCompletion {
  readonly aborted: boolean;
  readonly errors: readonly string[];
  readonly files: readonly IndexerManifestFile[];
  readonly ticket: IndexerScanTicket;
  readonly truncatedDirectories: readonly string[];
}
export interface IndexerScanReceipt {
  readonly manifest: IndexerManifestResult | null;
  readonly reason:
    | 'complete'
    | 'partial'
    | 'aborted'
    | 'scan-errors'
    | 'truncated'
    | 'write-failed'
    | 'manifest-mismatch';
  readonly scanComplete: boolean;
  readonly ticket: IndexerScanTicket;
}
export interface IndexProducerCapability {
  acquire(): Promise<IndexerStatus>;
  beginScan(request: IndexerScanStart): Promise<IndexerScanTicket>;
  commitTextFile(request: IndexerTextPublication): Promise<IndexerCommitResult>;
  commitVectorFile(request: IndexerVectorPublication): Promise<IndexerCommitResult>;
  configureVectorProfile(request: {
    readonly profile: IndexerEmbeddingProfile;
  }): Promise<IndexerIdentity>;
  finishScan(request: IndexerScanCompletion): Promise<IndexerScanReceipt>;
  prepareVectorFile(request: IndexerVectorPreparation): Promise<IndexerVectorPlan>;
  removeFile(request: {
    readonly rootId: string;
    readonly fileId: string;
    readonly scanTicket?: IndexerScanTicket;
  }): Promise<boolean>;
  verifyManifest(request: IndexerManifestRequest): Promise<IndexerManifestResult>;
}
export interface IndexerScanReadiness {
  getRootReadiness(): readonly IndexerRootReadiness[];
}
export type NativeIndexMode = 'TEXT' | 'VECTOR';
export function validateNativeIndexMode(input: unknown): NativeIndexMode | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (input === 'TEXT' || input === 'VECTOR') {
    return input;
  }
  throw new Error('Native indexing requires explicit TEXT or VECTOR mode.');
}
