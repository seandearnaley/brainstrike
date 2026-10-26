import type { DistanceMetric, EmbeddingProviderType } from './index.ts';

/** Browser-safe DTOs only. Native process ownership belongs to @brainstrike/indexer. */
export interface IndexerEmbeddingProfile {
  readonly dimensions: number;
  readonly distance: DistanceMetric;
  readonly modelId: string;
  readonly provider: EmbeddingProviderType;
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
  /** Same complete profile hash as status.embedding, after native producer-profile validation. */
  readonly profileHash: string | null;
  readonly requestId: string;
  readonly scanGeneration: number;
  readonly scope: { readonly kind: 'workspace'; readonly rootId: string };
  readonly storeId: string;
}
/**
 * Typed lifecycle refusal; no native objects or failure stacks cross the renderer boundary.
 * `rebuild-required`: the store refused to open its file (damaged, or a layout it does not
 * support), so only an explicit rebuild serves again (BST-1878).
 * `off`: the saved choice turned search off, so no index is open; turning it on serves again.
 */
export type NativeIndexRefusalCause =
  | { readonly kind: 'transitioning' }
  | { readonly kind: 'closed'; readonly reason: string }
  | {
      readonly kind:
        | 'off'
        | 'setup-required'
        | 'settings-invalid'
        | 'source-failure'
        | 'rebuild-required';
      readonly message: string;
    };

/** What search says under the saved Off choice, wherever it is refused: Main or the renderer. */
export const NATIVE_INDEX_OFF_MESSAGE = 'Search is off. Turn it on in Settings, Search & Indexing.';

/** What a workspace search or tool says when no folder is open: Main or the renderer. */
export const NO_WORKSPACE_FOLDER_MESSAGE =
  'No folder is open in the workspace. Add a folder in the left file tree first.';

/** A search naming a folder the index leaves out, such as a worktree not opted in. */
export const NATIVE_SEARCH_FOLDER_NOT_INDEXED = 'native-search.folder-not-indexed';

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

/**
 * What an unavailable index refuses a search with: its typed cause when the
 * lifecycle owner gave one, which the boundary maps to a fixed description and
 * remedy (`nativeIndexBoundaryFailure`), else a plain error that stays an
 * internal fault. The status reason may carry private diagnostics, so it is
 * never promoted to a model- or user-facing refusal; it rides as the inner
 * cause, which the boundary logs under the refusal's correlation id.
 */
export function indexerStatusFailure(
  status: Extract<IndexerStatus, { kind: 'unavailable' }>
): Error {
  return status.cause
    ? new NativeIndexRefusalError(status.cause, status.reason, {
        cause: new Error(status.reason),
      })
    : new Error(status.reason);
}

/** Readiness changes are projections of the native lifecycle owner, without stored resources. */
export type NativeIndexLifecycleObservation =
  | { readonly generation: number; readonly kind: 'ready' }
  | {
      readonly generation: number;
      readonly kind: 'preparing' | 'refused';
      readonly cause: NativeIndexRefusalCause;
    };

/**
 * What Main's index owner tells every window: its lifecycle, and the status and
 * the authorized roots' coverage read once after the lifecycle, a scan's start,
 * settle or invalidation, or a source's health changed. Nothing is read on a
 * timer, so a scan's counts are those it started from until it settles.
 */
export interface NativeIndexObservation {
  readonly lifecycle: NativeIndexLifecycleObservation;
  readonly progress:
    | {
        readonly kind: 'read';
        readonly status: IndexerStatus;
        /** Absent when the status is unavailable or no root is authorized. */
        readonly coverage?: IndexerCoverageBatch;
      }
    | { readonly kind: 'failed'; readonly reason: string };
}

export interface IndexLifecycleCapability {
  onLifecycleChanged(listener: (observation: NativeIndexObservation) => void): () => void;
}

/** Existing canonical source receipts, projected without a second readiness owner. */
export interface IndexerSourceObservation {
  readonly ownerGeneration: number;
  readonly readiness: readonly {
    readonly generation: number;
    readonly mutationRevision: number;
    readonly scanComplete: boolean;
    readonly scope: IndexerPublicationProgress['scope'];
  }[];
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
      readonly sourceObservation?: IndexerSourceObservation;
      readonly authorizedRootIds: readonly string[];
      readonly authorizedCollectionIds?: readonly string[];
      readonly queryPlan?: { readonly modelKey: string };
      readonly rootReadiness: readonly IndexerRootReadiness[];
    };
export interface IndexerCoverageRequest {
  readonly rootIds: readonly string[];
}
export interface IndexerCoverageCounts {
  readonly chunks: number;
  readonly indexedFiles: number;
  readonly missingVectors: number;
  readonly vectors: number;
}
export interface IndexerCoverage {
  readonly embedding: IndexerEmbeddingState;
  readonly roots: readonly (IndexerCoverageCounts & { readonly rootId: string })[];
  readonly storeId: string;
  readonly totals: IndexerCoverageCounts;
  /**
   * Every chunk of the requested scopes has its vector; does not establish complete root
   * scans. A scope with no chunks counts only with its complete-scan receipt, since alone
   * it cannot be told from a scope never scanned.
   */
  readonly vectorCoverageComplete: boolean;
}
export type IndexerSearchRequest = {
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
  /** Canonical producer proof for this read; absent on raw index-only capabilities. */
  readonly sourceComplete?: boolean;
  readonly sourceObservation?: IndexerSourceObservation;
  readonly storeId: string;
  readonly truncated: boolean;
}
/** Exact canonical relative paths in one workspace root (at most 100). */
export interface IndexerFileChunksRequest {
  readonly paths: readonly string[];
  readonly rootId: string;
}
export interface IndexerFileChunkBounds {
  readonly chunkId: string;
  readonly contentHash: string;
  readonly endLine: number;
  readonly startLine: number;
  readonly tokenCount: number | null;
}
/**
 * One requested path: its current index chunks' line bounds, or why it has
 * none. `not-indexed` is a bound file with no current chunks; `outside-index`
 * is a path the active native index does not bind (ignored, unscanned or not a
 * text file). Neither is an empty chunk list.
 */
export type IndexerFileChunks =
  | {
      readonly chunks: readonly IndexerFileChunkBounds[];
      readonly contentHash: string;
      readonly kind: 'indexed';
      readonly path: string;
    }
  | { readonly kind: 'not-indexed' | 'outside-index'; readonly path: string };
export interface IndexerFileChunksResult {
  readonly files: readonly IndexerFileChunks[];
  readonly rootId: string;
  readonly storeId: string;
}
/**
 * Chunk line bounds of files in one workspace root, without content or vectors
 * (BST-2015). A separate capability from search: a surface that draws a file's
 * chunks receives it by presence.
 */
export interface IndexChunkBoundsCapability {
  fileChunks(request: IndexerFileChunksRequest): Promise<IndexerFileChunksResult>;
}
export interface IndexerGrepRequest {
  readonly caseSensitive: boolean;
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

/** Same canonical profile identity used by native scoped storage. */
export function indexerEmbeddingProfileValues(
  profile: IndexerEmbeddingProfile
): readonly unknown[] {
  return [profile.provider, profile.modelId, profile.dimensions, profile.distance];
}

const EMBEDDING_PROVIDERS: readonly string[] = ['openai', 'google', 'cohere', 'voyage'];
const DISTANCE_METRICS: readonly string[] = ['cosine', 'l2', 'ip'];

export function validIndexerEmbeddingProfile(profile: IndexerEmbeddingProfile): boolean {
  return (
    profile.modelId.trim().length > 0 &&
    Number.isSafeInteger(profile.dimensions) &&
    profile.dimensions > 0 &&
    profile.dimensions <= 16_000 &&
    EMBEDDING_PROVIDERS.includes(profile.provider) &&
    DISTANCE_METRICS.includes(profile.distance)
  );
}
