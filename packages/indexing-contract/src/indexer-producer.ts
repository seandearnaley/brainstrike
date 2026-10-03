import type {
  IndexerEmbeddingProfile,
  IndexerEmbeddingState,
  IndexerRootReadiness,
  IndexerStatus,
} from './indexer-client.js';

/** Browser-safe write DTOs. Database paths, process policy and SQL stay in the main owner. */
export interface IndexerManifestFile {
  readonly contentHash: string;
  readonly fileId: string;
  readonly relativePath: string;
}
export interface IndexerManifestRequest {
  readonly files: readonly IndexerManifestFile[];
  readonly rootId: string;
}
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
export interface IndexerProvidedChunk {
  readonly chunkIndex: number;
  readonly chunkSize: number;
  readonly chunkType: 'text' | 'sentence' | 'recursive';
  readonly content: string;
  readonly contentHash: string;
  readonly endLine: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly startOffset: number;
  readonly tokenCount: number;
}
export interface IndexerCanonicalSnapshot {
  readonly content: string;
  readonly fileId: string;
  readonly providedChunks: readonly IndexerProvidedChunk[];
  readonly relativePath: string;
  readonly rootId: string;
}
export interface IndexerFileSyntax {
  readonly refs: readonly {
    readonly fileRecordId: string;
    readonly fromSymbolSeq?: number;
    readonly kind: 'call' | 'extends' | 'implements' | 'import';
    readonly line: number;
    readonly module?: string;
    readonly name: string;
    readonly seq: number;
  }[];
  readonly symbols: readonly {
    readonly endLine: number;
    readonly endOffset: number;
    readonly exported: boolean;
    readonly fileRecordId: string;
    readonly kind: 'class' | 'enum' | 'function' | 'interface' | 'method' | 'type' | 'variable';
    readonly name: string;
    readonly seq: number;
    readonly startLine: number;
    readonly startOffset: number;
  }[];
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
export interface IndexerCommitResult {
  readonly reusedEmbeddings: number;
  readonly syntaxStatus: 'replaced' | 'retained' | 'not-provided';
  readonly unchanged: boolean;
  readonly writtenChunks: number;
  readonly writtenRefs: number;
  readonly writtenSymbols: number;
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
/** Explicit durable inference choices; model names alone never select revision/device/dtype. */
export interface NativeLocalSelection {
  readonly device: 'webgpu' | 'wasm';
  readonly dimensions: number;
  readonly dtype: string;
  readonly modelId: string;
  readonly revision: string;
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
export function validateNativeLocalSelection(input: unknown): NativeLocalSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Native local inference requires explicit saved choices.');
  }
  const modelId: unknown = Reflect.get(input, 'modelId');
  const dimensions: unknown = Reflect.get(input, 'dimensions');
  const revision: unknown = Reflect.get(input, 'revision');
  const device: unknown = Reflect.get(input, 'device');
  const dtype: unknown = Reflect.get(input, 'dtype');
  if (
    typeof modelId !== 'string' ||
    !modelId.trim() ||
    typeof dimensions !== 'number' ||
    !Number.isSafeInteger(dimensions) ||
    dimensions <= 0 ||
    typeof revision !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    (device !== 'wasm' && device !== 'webgpu') ||
    typeof dtype !== 'string' ||
    !dtype.trim()
  ) {
    throw new Error(
      'Native local inference requires explicit saved model, dimensions, revision, device and dtype.'
    );
  }
  return { device, dimensions, dtype, modelId, revision };
}
