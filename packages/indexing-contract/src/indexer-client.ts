/** Browser-safe DTOs only. Native process ownership belongs to @brainstrike/indexer. */
export interface IndexerEmbeddingProfile {
  readonly dimensions: number;
  readonly distance?: 'cosine' | 'l2' | 'ip';
  readonly dtype?: 'q4' | 'q8' | 'fp16' | 'fp32';
  readonly modelId: string;
  /** A local model's pooling (BST-1993); absent means 'mean'. */
  readonly pooling?: 'mean' | 'cls';
  /** A local model's catalog prompts (BST-1993); none is two empty strings. */
  readonly prompts?: { readonly document: string; readonly query: string };
  readonly provider?:
    | 'local'
    | 'transformers'
    | 'openai'
    | 'google'
    | 'cohere'
    | 'voyage'
    | 'ollama'
    | 'lmstudio';
  readonly revision?: string;
  readonly tokenCap?: number;
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
/** Historical native commit ACKs in one owned scan; never current coverage or completion. */
export interface IndexerPublicationProgress {
  readonly acknowledgedFiles: number;
  readonly authorityEpoch: string;
  readonly authorityRevision: number;
  readonly mutationRevision: number;
  readonly ownerGeneration: number;
  /** Same complete local-profile hash as status.embedding, after native producer-profile validation. */
  readonly profileHash: string | null;
  readonly requestId: string;
  readonly scanGeneration: number;
  readonly scope:
    | { readonly kind: 'workspace'; readonly rootId: string }
    | { readonly kind: 'collection'; readonly embeddingSetId: string };
  readonly storeId: string;
}
/** Typed lifecycle refusal; no native objects or failure stacks cross the renderer boundary. */
export type NativeIndexRefusalCause =
  | { readonly kind: 'transitioning' }
  | { readonly kind: 'closed'; readonly reason: string }
  | {
      readonly kind: 'setup-required' | 'settings-invalid' | 'source-failure';
      readonly message: string;
    };

/** Only the lifecycle/resource owner can refuse admission with this typed cause. */
export class NativeIndexRefusalError extends Error {
  readonly code: `native-index-${NativeIndexRefusalCause['kind']}`;
  readonly refusal: NativeIndexRefusalCause;

  constructor(refusal: NativeIndexRefusalCause, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NativeIndexRefusalError';
    this.refusal = refusal;
    this.code = `native-index-${refusal.kind}`;
  }
}

/** Readiness changes are projections of the native lifecycle owner, without stored resources. */
export type NativeIndexLifecycleObservation =
  | { readonly generation: number; readonly kind: 'ready' }
  | {
      readonly generation: number;
      readonly kind: 'preparing' | 'refused';
      readonly cause: NativeIndexRefusalCause;
    };

export interface IndexLifecycleCapability {
  onLifecycleChanged(listener: (observation: NativeIndexLifecycleObservation) => void): () => void;
}

export type IndexerStatus =
  | {
      readonly kind: 'unavailable';
      readonly reason: string;
      readonly phase?: 'setup-required' | 'preparing' | 'blocked';
      readonly cause?: NativeIndexRefusalCause;
    }
  | {
      readonly kind: 'ready';
      readonly embedding: IndexerEmbeddingState;
      readonly storeId: string;
      readonly publicationProgress?: readonly IndexerPublicationProgress[];
      readonly authorizedRootIds: readonly string[];
      readonly authorizedCollectionIds?: readonly string[];
      readonly collectionReadiness?: readonly {
        readonly embeddingSetId: string;
        readonly scanComplete: boolean;
      }[];
      readonly queryPlan?: {
        readonly modelKey: string;
        readonly inferencePlan?: {
          readonly modelId: string;
          readonly revision?: string;
          readonly dimensions: number;
          readonly dtype: 'q4' | 'q8' | 'fp16' | 'fp32';
          readonly device: 'wasm' | 'webgpu';
          /** The catalog model's pooling (BST-1993); absent means 'mean'. */
          readonly pooling?: 'mean' | 'cls';
          /** The catalog model's prompts (BST-1993); absent means none. */
          readonly prompts?: { readonly document: string; readonly query: string };
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
  /** Exact canonical relative paths, selected before the candidate limit. */
  readonly filePaths?: readonly string[];
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
export interface IndexerCoverageCurrentObservation {
  /** Results preserve request order and independent scope counters. */
  readonly coverage: readonly IndexerCoverage[];
  readonly kind: 'current';
  /** Canonical readiness from the same before/after fenced observation as coverage. */
  readonly status: Extract<IndexerStatus, { kind: 'ready' }>;
}
/** A rejected observation has no status or counters; callers must obtain a fresh batch. */
export interface IndexerCoverageInvalidatedObservation {
  readonly cause?: NativeIndexRefusalCause;
  readonly code: 'native-coverage-observation-invalidated';
  readonly kind: 'invalidated';
}
/** A retained activation failure has no current authority or counters. */
export interface IndexerCoverageBlockedObservation {
  readonly cause?: NativeIndexRefusalCause;
  readonly kind: 'blocked';
  readonly reason: string;
}
export type IndexerCoverageBatch =
  | IndexerCoverageCurrentObservation
  | IndexerCoverageInvalidatedObservation
  | IndexerCoverageBlockedObservation;
/** Desktop notification after canonical roots commit; Main alone resolves grants and IDs. */
export interface IndexRootRegistrationCapability {
  rootsRegistered(): Promise<void>;
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

/**
 * Same canonical profile identity used by native scoped storage; legacy foundation stays unchanged.
 * Mirrors the native rules: the default 'mean' pooling adds nothing and 'cls' is appended; a
 * profile that states catalog prompts (none being two empty strings) appends the pair.
 */
export function indexerEmbeddingProfileValues(
  profile: IndexerEmbeddingProfile
): readonly unknown[] {
  const pooling = [
    ...(profile.pooling === 'cls' ? ['cls'] : []),
    ...(profile.prompts ? [[profile.prompts.query, profile.prompts.document]] : []),
  ];
  return profile.provider === undefined
    ? [
        profile.modelId,
        profile.revision ?? null,
        profile.dtype ?? null,
        profile.dimensions,
        profile.tokenCap ?? null,
        ...pooling,
      ]
    : [
        profile.provider,
        profile.modelId,
        profile.dimensions,
        profile.distance ?? null,
        profile.revision ?? null,
        profile.dtype ?? null,
        profile.tokenCap ?? null,
        ...pooling,
      ];
}
export function validIndexerEmbeddingProfile(profile: IndexerEmbeddingProfile): boolean {
  if (
    !(
      profile.modelId.trim() &&
      Number.isSafeInteger(profile.dimensions) &&
      profile.dimensions > 0 &&
      profile.dimensions <= 16_000
    )
  ) {
    return false;
  }
  if (
    profile.provider !== undefined &&
    ![
      'local',
      'transformers',
      'openai',
      'google',
      'cohere',
      'voyage',
      'ollama',
      'lmstudio',
    ].includes(profile.provider)
  ) {
    return false;
  }
  const local =
    profile.provider === undefined ||
    profile.provider === 'local' ||
    profile.provider === 'transformers';
  if (!local) {
    return (
      ['cosine', 'l2', 'ip'].includes(profile.distance ?? '') &&
      profile.dtype === undefined &&
      profile.pooling === undefined &&
      profile.prompts === undefined &&
      profile.revision === undefined &&
      profile.tokenCap === undefined
    );
  }
  return (
    (profile.pooling === undefined || profile.pooling === 'mean' || profile.pooling === 'cls') &&
    (profile.prompts === undefined ||
      (typeof profile.prompts.query === 'string' &&
        typeof profile.prompts.document === 'string')) &&
    (profile.provider === undefined || ['cosine', 'l2', 'ip'].includes(profile.distance ?? '')) &&
    profile.dtype !== undefined &&
    ['q4', 'q8', 'fp16', 'fp32'].includes(profile.dtype) &&
    (profile.revision === undefined || /^[a-f0-9]{40}$/u.test(profile.revision)) &&
    (profile.tokenCap === undefined ||
      (Number.isSafeInteger(profile.tokenCap) && profile.tokenCap > 0))
  );
}
