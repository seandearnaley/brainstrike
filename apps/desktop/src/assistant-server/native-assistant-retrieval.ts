import { ToolInputError } from '@brainstrike/assistant-contract';
import { requestedEmbeddingPooling } from '@brainstrike/indexing-contract';
import type {
  IndexerSearchHit,
  IndexerSearchResult,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import {
  fuseNativeSearchPools,
  getNativeSemanticAvailability,
  NATIVE_SEARCH_CANDIDATE_LIMIT,
  NATIVE_SEARCH_FINAL_LIMIT,
} from '@brainstrike/workspace-search/core';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { EmbeddingSetRow } from './retrieval-store';

interface NativeAssistantRequest {
  admittedWorkspaceRootIds?: readonly string[] | undefined;
  capability: IndexSearchCapability;
  chunkType?: string | undefined;
  embeddingHostManager: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  embeddingSet: EmbeddingSetRow;
  embeddingSetId: string;
  filePaths?: readonly string[] | undefined;
  ftsWeight?: number | undefined;
  limit?: number | undefined;
  mode: 'semantic' | 'hybrid';
  query: string;
  rootId?: string | undefined;
  selectionSnapshotId?: string | undefined;
  signal?: AbortSignal | undefined;
  threshold: number;
  vectorWeight?: number | undefined;
}
export interface NativeAssistantHit {
  ftsRank?: number;
  hit: IndexerSearchHit;
  rrfScore: number;
  similarity?: number;
  sourceCount: number;
}
function executionIdentity(status: IndexerStatus): string {
  if (status.kind !== 'ready') {
    return JSON.stringify(status);
  }
  const {
    collectionReadiness: _collections,
    rootReadiness: _roots,
    publicationProgress: _progress,
    sourceObservation,
    ...identity
  } = status;
  // Scan receipts change as committed rows become available; only their owner
  // generation participates in the query's authority identity.
  return JSON.stringify({ ...identity, ownerGeneration: sourceObservation?.ownerGeneration });
}

function refuse(message: string): never {
  throw new ToolInputError(message);
}

/** BST-1943: an omitted root queried the whole collection despite Main's CLI subset. */
export function resolveAdmittedRetrievalRoots(
  admitted: readonly string[] | undefined,
  explicitRootId: string | undefined
): readonly string[] | undefined {
  if (admitted === undefined) {
    return;
  }
  if (
    admitted.length === 0 ||
    new Set(admitted).size !== admitted.length ||
    (explicitRootId !== undefined && !admitted.includes(explicitRootId))
  ) {
    refuse(
      '[ERR_CLI_WORKSPACE_RETRIEVAL_UNAVAILABLE] Retrieval requires a nonempty admitted workspace root scope.'
    );
  }
  return explicitRootId === undefined ? admitted : [explicitRootId];
}

function resolveNativeLimit(request: NativeAssistantRequest): number {
  if (
    request.filePaths !== undefined ||
    request.selectionSnapshotId !== undefined ||
    request.chunkType !== undefined
  ) {
    refuse(
      'Native assistant retrieval does not support filePaths, selectionSnapshotId, or chunkType filters. Use a query and root scope.'
    );
  }
  if ((request.ftsWeight ?? 1) !== 1 || (request.vectorWeight ?? 1) !== 1) {
    refuse('Native hybrid search uses fixed equal RRF60 weights.');
  }
  const limit = request.limit ?? NATIVE_SEARCH_FINAL_LIMIT;
  if (limit > NATIVE_SEARCH_FINAL_LIMIT) {
    refuse('Native assistant retrieval supports at most 10 results.');
  }
  return limit;
}

function assertNativeVector(vector: readonly number[], dimensions: number): void {
  if (
    vector.length !== dimensions ||
    vector.some((value) => !Number.isFinite(value)) ||
    !vector.some((value) => value !== 0)
  ) {
    refuse('Native query embedding is invalid for the saved profile.');
  }
}

/** Omitted tool scope resolves through main's saved native collection, not legacy renderer status. */
export async function resolveNativeAssistantCollection(
  capability: IndexSearchCapability,
  explicitId: string | undefined,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const status = await capability.status();
  signal?.throwIfAborted();
  if (status.kind !== 'ready') {
    refuse('Native search is unavailable. Rebuild or restore the native index before retrying.');
  }
  if (status.embedding.indexMode !== 'vector-configured') {
    refuse(
      'Native semantic and hybrid search require explicit VECTOR mode; the current index is TEXT.'
    );
  }
  const collections = status.authorizedCollectionIds ?? [];
  const explicit = explicitId?.trim();
  if (explicit) {
    if (!collections.includes(explicit)) {
      refuse('The requested embedding collection is not authorized by the current native index.');
    }
    return explicit;
  }
  const collection = collections[0];
  if (collections.length !== 1 || collection === undefined) {
    refuse('Native assistant retrieval requires one saved authorized collection.');
  }
  return collection;
}

/** Uses the existing main capability and hidden query transport; owns no reader or inference runtime. */
export async function searchNativeAssistantChunks(request: NativeAssistantRequest): Promise<{
  assertCurrent: () => Promise<void>;
  hits: NativeAssistantHit[];
  hint?: string;
  limit: number;
  truncated: boolean;
  vectorResultCount: number;
  ftsResultCount: number;
}> {
  const { capability, embeddingSet, embeddingSetId, query, signal } = request;
  signal?.throwIfAborted();
  const admitted = resolveAdmittedRetrievalRoots(request.admittedWorkspaceRootIds, request.rootId);
  const limit = resolveNativeLimit(request);
  const status = await capability.status();
  signal?.throwIfAborted();
  if (status.kind !== 'ready') {
    refuse('Native search is unavailable. Rebuild or restore the native index before retrying.');
  }
  if (status.embedding.indexMode !== 'vector-configured') {
    refuse(
      'Native semantic and hybrid search require explicit VECTOR mode; the current index is TEXT.'
    );
  }
  if (!status.authorizedCollectionIds?.includes(embeddingSetId)) {
    refuse('The requested embedding collection is not authorized by the current native index.');
  }
  const { profile } = status.embedding;
  const plan = status.queryPlan;
  assertSelectedQueryIdentity(profile, plan, embeddingSet);
  const rootIds = admitted ?? (request.rootId === undefined ? [] : [request.rootId]);
  // Main authorizes only the active collection's bindings. A root scope intersects
  // those bindings; verify membership again on every returned canonical hit.
  const scope = {
    rootIds,
    // The factory gives collectionId precedence over roots. Use its existing
    // root query for a CLI subset; retain saved collection validation above and
    // membership validation on every hit below. Ordinary Desktop stays unchanged.
    ...(admitted === undefined && request.rootId === undefined
      ? { collectionId: embeddingSetId }
      : {}),
  };
  let coverageHint: string | undefined;
  let scanLimited = false;
  const assertCurrent = async (): Promise<void> => {
    signal?.throwIfAborted();
    const availability = await getNativeSemanticAvailability({ capability, profile, ...scope });
    signal?.throwIfAborted();
    if (!availability.available) {
      refuse(availability.reason ?? 'Native semantic coverage is unavailable.');
    }
    coverageHint ??= availability.hint;
    const current = await capability.status();
    signal?.throwIfAborted();
    if (executionIdentity(current) !== executionIdentity(status)) {
      refuse(
        'Native search authority or saved query profile changed during retrieval. Retry the query.'
      );
    }
  };
  await assertCurrent();
  const host = request.embeddingHostManager;
  if (!host) {
    refuse('Local embedding query host is unavailable.');
  }
  // The manager joins physical settlement on success, cancellation and failure.
  // Preserve the exact signal and saved scalar plan; queryEmbedding owns query task/prefix.
  const payload = {
    dimensions: profile.dimensions,
    ...(plan.inferencePlan ? { inferencePlan: plan.inferencePlan } : {}),
    modelId: profile.modelId,
    modelKey: plan.modelKey,
    query,
  };
  const vector = await host.queryEmbedding(payload, signal ? { signal } : undefined);
  signal?.throwIfAborted();
  assertNativeVector(vector, profile.dimensions);
  await assertCurrent();
  const read = () =>
    capability.search({
      ...scope,
      limit: NATIVE_SEARCH_CANDIDATE_LIMIT,
      mode: 'vector',
      profile,
      vector,
    });
  const validatePool = (pool: IndexerSearchResult): void => {
    if (
      pool.storeId !== status.storeId ||
      JSON.stringify(pool.embedding) !== JSON.stringify(status.embedding) ||
      pool.hits.length > NATIVE_SEARCH_CANDIDATE_LIMIT
    ) {
      refuse('Native search returned an incomplete or changed store/profile scope.');
    }
    scanLimited ||= pool.scanLimited;
    for (const hit of pool.hits) {
      if (
        hit.embeddingSetId !== embeddingSetId ||
        (rootIds.length > 0 && (hit.rootId === null || !rootIds.includes(hit.rootId))) ||
        !Number.isFinite(hit.score) ||
        hit.chunkIndex === null ||
        hit.chunkIndex < 0 ||
        hit.startLine < 1 ||
        hit.endLine < hit.startLine ||
        hit.tokenCount === null ||
        hit.tokenCount <= 0
      ) {
        refuse(
          'Native search returned a chunk outside the requested canonical scope or source metadata.'
        );
      }
    }
  };
  let hits: NativeAssistantHit[];
  let truncated: boolean;
  let vectorResultCount: number;
  let ftsResultCount = 0;
  if (request.mode === 'semantic') {
    const pool = await read();
    validatePool(pool);
    const selected = pool.hits.filter(
      (hit) => distanceSimilarity(hit.score, embeddingSet.distance) >= request.threshold
    );
    hits = selected.slice(0, limit).map((hit) => ({
      hit,
      rrfScore: 0,
      similarity: distanceSimilarity(hit.score, embeddingSet.distance),
      sourceCount: 1,
    }));
    vectorResultCount = selected.length;
    truncated = pool.truncated || pool.candidatesTruncated || selected.length > limit;
  } else {
    // Join every admitted native arm even if another fails; never publish a partial fusion.
    const arms = await Promise.allSettled([
      read(),
      capability.search({
        ...scope,
        limit: NATIVE_SEARCH_CANDIDATE_LIMIT,
        mode: 'bm25',
        text: query,
      }),
      capability.grep({
        ...scope,
        caseSensitive: false,
        isRegex: false,
        limit: NATIVE_SEARCH_CANDIDATE_LIMIT,
        pattern: query,
      }),
    ]);
    const failures = arms.flatMap((arm) =>
      arm.status === 'rejected' ? [arm.reason as unknown] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Native hybrid search failed.');
    }
    const pools = arms.map((arm) => {
      if (arm.status !== 'fulfilled') {
        throw new Error('Native search settlement invariant failed.');
      }
      validatePool(arm.value);
      return arm.value;
    });
    const [vectorPool, bm25, grep] = pools;
    if (!(vectorPool && bm25 && grep)) {
      throw new Error('Native search pool invariant failed.');
    }
    const vectorHits = vectorPool.hits.filter(
      (hit) => distanceSimilarity(hit.score, embeddingSet.distance) >= request.threshold
    );
    const fused = fuseNativeSearchPools(
      { bm25, grep, vector: { ...vectorPool, hits: vectorHits } },
      status
    );
    hits = fused.hits.slice(0, limit).map(({ hit, rrfScore }) => {
      const vectorHit = vectorHits.find((item) => item.chunkId === hit.chunkId);
      const keywordHit = bm25.hits.find((item) => item.chunkId === hit.chunkId);
      return {
        hit,
        rrfScore,
        sourceCount:
          Number(!!vectorHit) +
          Number(!!keywordHit) +
          Number(grep.hits.some((item) => item.chunkId === hit.chunkId)),
        ...(vectorHit
          ? { similarity: distanceSimilarity(vectorHit.score, embeddingSet.distance) }
          : {}),
        ...(keywordHit ? { ftsRank: -keywordHit.score } : {}),
      };
    });
    vectorResultCount = vectorHits.length;
    ftsResultCount = bm25.hits.length;
    truncated = fused.truncated || fused.candidatesTruncated || fused.hits.length > limit;
  }
  await assertCurrent();
  const hint = retrievalHint(coverageHint, scanLimited, truncated);
  return {
    assertCurrent,
    ftsResultCount,
    hits,
    limit,
    truncated,
    vectorResultCount,
    ...(hint ? { hint } : {}),
  };
}

function retrievalHint(
  coverageHint: string | undefined,
  scanLimited: boolean,
  truncated: boolean
): string | undefined {
  const hints = [
    coverageHint ??
      (scanLimited
        ? 'Partial index coverage: results cover the indexed subset while source scanning is incomplete.'
        : undefined),
    truncated
      ? 'Native retrieval is limited to 100 candidates per arm and 10 final results. Narrow the query or root scope.'
      : undefined,
  ].filter((hint): hint is string => hint !== undefined);
  return hints.length > 0 ? hints.join(' ') : undefined;
}

/** Match the original collection search policy's normalized metric scores. */
function distanceSimilarity(score: number, distance: string | null): number {
  if (distance === 'l2') {
    return 1 / (1 + score);
  }
  if (distance === 'ip') {
    return 1 / (1 + Math.exp(score));
  }
  if (distance === 'cosine') {
    return 1 - score / 2;
  }
  throw new Error('Native collection distance is unsupported.');
}
function assertSelectedQueryIdentity(
  profile: import('@brainstrike/indexing-contract/indexer-client').IndexerEmbeddingProfile,
  plan: Extract<
    import('@brainstrike/indexing-contract/indexer-client').IndexerStatus,
    { kind: 'ready' }
  >['queryPlan'],
  selectedSet: EmbeddingSetRow
): asserts plan is NonNullable<typeof plan> {
  if (
    !plan ||
    plan.modelKey !== selectedSet.modelKey ||
    profile.modelId !== selectedSet.modelId ||
    selectedSet.dimensions !== profile.dimensions ||
    (profile.distance !== undefined && profile.distance !== selectedSet.distance) ||
    !['cosine', 'l2', 'ip'].includes(selectedSet.distance ?? '') ||
    (plan.inferencePlan
      ? plan.inferencePlan.modelId !== profile.modelId ||
        plan.inferencePlan.revision !== profile.revision ||
        plan.inferencePlan.dimensions !== profile.dimensions ||
        plan.inferencePlan.dtype !== profile.dtype ||
        requestedEmbeddingPooling(plan.inferencePlan) !== requestedEmbeddingPooling(profile) ||
        !samePrompts(plan.inferencePlan.prompts, profile.prompts) ||
        !['wasm', 'webgpu'].includes(plan.inferencePlan.device)
      : profile.provider === undefined ||
        profile.provider === 'local' ||
        profile.provider === 'transformers')
  ) {
    refuse(
      'Native query inference requires the exact saved model, revision, dimensions, dtype, pooling, prompts, device and distance profile.'
    );
  }
}

/** Two plans state the same catalog prompts (or both predate stated prompts). */
function samePrompts(
  left: { readonly document: string; readonly query: string } | undefined,
  right: { readonly document: string; readonly query: string } | undefined
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.query === right.query && left.document === right.document;
}
