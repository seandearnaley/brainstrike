import type {
  IndexerCoverage,
  IndexerEmbeddingProfile,
  IndexerEmbeddingState,
  IndexerStatus,
} from '../../../../packages/indexing-contract/src/indexer-client';
import { summarize } from '../../e2e/utils/foreground-latency-probes.ts';

export const MATCHED_CORPUS = {
  bytes: 3_864_680,
  files: 1000,
  historicalChunks: 6962,
  seed: 1925,
  sha256: '64dcd0167650bc048e28b1b73e009b32aa427a364ff68559d09594f474e2fd23',
} as const;

export interface NativeBenchmarkScope {
  readonly collectionId?: string;
  readonly files: number;
  readonly mode: 'text' | 'vector';
  readonly profile?: IndexerEmbeddingProfile;
  readonly rootId: string;
  readonly storeId: string;
}

function coverageMatchesMode(
  embedding: IndexerEmbeddingState,
  coverage: IndexerCoverage,
  scope: NativeBenchmarkScope
): boolean {
  if (scope.mode === 'text') {
    return (
      embedding.indexMode === 'text-only' &&
      coverage.embedding.indexMode === 'text-only' &&
      coverage.totals.vectors === 0
    );
  }
  if (!scope.profile) {
    throw new Error('Vector benchmark requires an explicit immutable profile.');
  }
  if (
    embedding.indexMode !== 'vector-configured' ||
    coverage.embedding.indexMode !== 'vector-configured'
  ) {
    return false;
  }
  const fields = ['modelId', 'revision', 'dtype', 'dimensions', 'tokenCap'] as const;
  if (
    !fields.every(
      (field) =>
        embedding.indexMode === 'vector-configured' &&
        coverage.embedding.indexMode === 'vector-configured' &&
        embedding.profile[field] === scope.profile?.[field] &&
        coverage.embedding.profile[field] === scope.profile?.[field]
    )
  ) {
    return false;
  }
  return (
    coverage.embedding.profileHash === embedding.profileHash &&
    coverage.vectorCoverageComplete &&
    coverage.totals.missingVectors === 0 &&
    coverage.totals.vectors === coverage.totals.chunks
  );
}

function collectionBuildComplete(
  status: Extract<IndexerStatus, { readonly kind: 'ready' }>,
  coverage: IndexerCoverage | null,
  scope: NativeBenchmarkScope
): boolean {
  if (
    !(scope.collectionId?.trim() && coverage) ||
    status.authorizedCollectionIds?.length !== 1 ||
    status.authorizedCollectionIds[0] !== scope.collectionId ||
    status.collectionReadiness?.length !== 1 ||
    status.collectionReadiness[0]?.embeddingSetId !== scope.collectionId ||
    !status.collectionReadiness[0].scanComplete ||
    coverage.storeId !== scope.storeId ||
    coverage.roots.length !== 0 ||
    coverage.collections?.length !== 1 ||
    coverage.collections[0]?.embeddingSetId !== scope.collectionId ||
    coverage.totals.indexedFiles !== scope.files ||
    coverage.totals.chunks <= 0
  ) {
    return false;
  }
  const counters = ['indexedFiles', 'chunks', 'vectors', 'missingVectors'] as const;
  return (
    counters.every((field) => coverage.collections?.[0]?.[field] === coverage.totals[field]) &&
    coverageMatchesMode(status.embedding, coverage, scope)
  );
}

/** Caller supplies status and both coverage results from one fenced coverageBatch observation. */
export function nativeBuildComplete(
  status: IndexerStatus,
  coverage: IndexerCoverage | null,
  scope: NativeBenchmarkScope,
  collectionCoverage: IndexerCoverage | null = null
): boolean {
  if (
    status.kind !== 'ready' ||
    !coverage ||
    status.storeId !== scope.storeId ||
    coverage.storeId !== scope.storeId ||
    status.authorizedRootIds.length !== 1 ||
    status.authorizedRootIds[0] !== scope.rootId ||
    status.rootReadiness.length !== 1 ||
    status.rootReadiness[0]?.rootId !== scope.rootId ||
    !status.rootReadiness[0].scanComplete ||
    coverage.roots.length !== 1 ||
    coverage.roots[0]?.rootId !== scope.rootId ||
    coverage.totals.indexedFiles !== scope.files ||
    coverage.totals.chunks <= 0
  ) {
    return false;
  }
  const counters = ['indexedFiles', 'chunks', 'vectors', 'missingVectors'] as const;
  return (
    counters.every((field) => coverage.roots[0]?.[field] === coverage.totals[field]) &&
    coverageMatchesMode(status.embedding, coverage, scope) &&
    (scope.collectionId === undefined || collectionBuildComplete(status, collectionCoverage, scope))
  );
}

export interface NativeBenchmarkSamples {
  readonly completedChunks: number;
  readonly elapsedMs: number;
  readonly errors: readonly string[];
  readonly idleChat: readonly number[];
  readonly idleFrames: readonly number[];
  readonly idleTool: readonly number[];
  readonly loadedChat: readonly number[];
  readonly loadedFrames: readonly number[];
  readonly loadedLongTasks: readonly number[];
  readonly loadedTool: readonly number[];
}

export function assessNativeBenchmark(samples: NativeBenchmarkSamples): {
  readonly validityErrors: readonly string[];
  readonly gates: {
    readonly frames: boolean;
    readonly chat: boolean;
    readonly nativeTool: boolean;
    readonly throughput: boolean;
  };
  readonly chunksPerSecond: number;
} {
  const validityErrors = [...samples.errors];
  if (samples.elapsedMs < 60_000) {
    validityErrors.push('Build is below the preserved 60-second latency validity floor.');
  }
  if (samples.loadedChat.length < 100 || samples.loadedTool.length < 100) {
    validityErrors.push('Each loaded foreground probe requires at least 100 samples.');
  }
  if (
    samples.idleChat.length < 100 ||
    samples.idleChat.some((duration) => !Number.isFinite(duration) || duration < 0)
  ) {
    validityErrors.push(
      'The controlled idle chat baseline requires at least 100 finite nonnegative samples.'
    );
  }
  if (summarize(samples.idleFrames).p50 > 20 || samples.idleFrames.length === 0) {
    validityErrors.push('Visible renderer did not produce display-rate idle frames.');
  }
  const chunksPerSecond = samples.completedChunks / (samples.elapsedMs / 1000);
  return {
    chunksPerSecond,
    gates: {
      chat: summarize(samples.loadedChat).p95 <= 49.93 + 5,
      frames: summarize(samples.loadedFrames).max < 50 && samples.loadedLongTasks.length === 0,
      nativeTool: summarize(samples.loadedTool).p95 <= 2 * summarize(samples.idleTool).p95,
      throughput: chunksPerSecond > 213,
    },
    validityErrors,
  };
}
