import { ToolInputError } from '@brainstrike/assistant-contract';
import type {
  IndexerSearchHit,
  IndexerSearchResult,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { isWorkspaceSecretFile } from '@brainstrike/utils';
import {
  fuseNativeSearchPools,
  getNativeSemanticAvailability,
  NATIVE_SEARCH_CANDIDATE_LIMIT,
  NATIVE_SEARCH_FINAL_LIMIT,
} from '@brainstrike/workspace-search/core';
import {
  type CheckoutReadThrough,
  cachedCheckoutReader,
  type ReadCheckoutFile,
  type ResolveCheckout,
  relocateCheckoutHits,
  resolveCheckoutReadThrough,
} from './checkout-read-through';
import type { QueryEmbedder } from './retrieval-core';
import type { EmbeddingSetRow } from './retrieval-store';

/** How a worktree folder reads another checkout's index (ADR-0034); absent, it reads none. */
export interface CheckoutAccess {
  readonly read: ReadCheckoutFile;
  readonly resolve: ResolveCheckout;
}

interface NativeAssistantRequest {
  admittedWorkspaceRootIds?: readonly string[] | undefined;
  /** The thread's operating folder: a worktree, or the checkout it reads through. */
  boundRootId?: string | undefined;
  capability: IndexSearchCapability;
  checkout?: CheckoutAccess | undefined;
  chunkType?: string | undefined;
  embeddingSet: EmbeddingSetRow;
  embeddingSetId: string;
  filePaths?: readonly string[] | undefined;
  ftsWeight?: number | undefined;
  limit?: number | undefined;
  mode: 'semantic' | 'hybrid';
  query: string;
  queryEmbedder: QueryEmbedder | undefined;
  rootId?: string | undefined;
  selectionSnapshotId?: string | undefined;
  signal?: AbortSignal | undefined;
  threshold: number;
  vectorWeight?: number | undefined;
  /** The run's open folders, which name a folder the index leaves out. */
  workspaceRoots?: readonly { readonly displayName: string; readonly rootId: string }[] | undefined;
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

function rootName(rootId: string, roots: NativeAssistantRequest['workspaceRoots']): string {
  return `"${roots?.find((root) => root.rootId === rootId)?.displayName ?? rootId}"`;
}

/** Folders the index cannot answer for, and how to read them. */
function unindexedFoldersNote(
  rootIds: readonly string[],
  roots: NativeAssistantRequest['workspaceRoots']
): string {
  const names = rootIds.map((rootId) => rootName(rootId, roots));
  return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not in the search index; grepSearch and readWorkspaceFile read any open folder directly.`;
}

/**
 * The folders to query. A requested folder the index leaves out reads the index
 * of an open checkout of the same repository when it has one (a worktree,
 * ADR-0034); any other is named to the model rather than asked for, and a
 * request the index can answer for none of is refused.
 */
async function searchScope(
  requested: readonly string[],
  authorized: readonly string[],
  request: NativeAssistantRequest
): Promise<{
  readonly readThrough: readonly CheckoutReadThrough[];
  readonly rootIds: readonly string[];
  readonly unindexedNote: string | undefined;
}> {
  const indexed = requested.filter((rootId) => authorized.includes(rootId));
  const unindexed = requested.filter((rootId) => !authorized.includes(rootId));
  const paired = request.checkout
    ? await resolveCheckoutReadThrough({
        indexed: authorized,
        resolveCheckout: request.checkout.resolve,
        roots: request.workspaceRoots ?? [],
        unindexed,
      })
    : [];
  // A checkout searched for itself answers for its worktrees as itself, unless
  // the thread works in the worktree: then its rows move onto the worktree.
  const readThrough = paired.filter(
    (pair) => !indexed.includes(pair.sourceRootId) || request.boundRootId === pair.worktreeRootId
  );
  const rootIds = [...new Set([...indexed, ...readThrough.map((pair) => pair.sourceRootId)])];
  const missing = unindexed.filter(
    (rootId) => !paired.some((pair) => pair.worktreeRootId === rootId)
  );
  const unindexedNote =
    missing.length === 0 ? undefined : unindexedFoldersNote(missing, request.workspaceRoots);
  if (rootIds.length === 0 && unindexedNote !== undefined) {
    refuse(unindexedNote);
  }
  return { readThrough, rootIds, unindexedNote };
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

/**
 * Indexing skips credential files, but a chunk stored before that floor, or
 * kept by a truncated reconciliation, still answers a query. Dropped from each
 * validated pool before selection and fusion, it never reaches the model.
 */
function withoutCredentialHits(pool: IndexerSearchResult): IndexerSearchResult {
  const hits = pool.hits.filter(
    (hit) => hit.relativePath === null || !isWorkspaceSecretFile(hit.relativePath)
  );
  return hits.length === pool.hits.length ? pool : { ...pool, hits };
}

/** Uses the existing main capability and hidden query transport; owns no reader or inference runtime. */
export async function searchNativeAssistantChunks(request: NativeAssistantRequest): Promise<{
  assertCurrent: () => Promise<void>;
  hits: NativeAssistantHit[];
  hint?: string;
  limit: number;
  /** Worktree folders answered from another checkout's index; their hits carry the worktree's root. */
  readThrough: readonly CheckoutReadThrough[];
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
  // With no folder named, the run's open folders: the index's of them, any other named.
  const { readThrough, rootIds, unindexedNote } = await searchScope(
    admitted ??
      (request.rootId === undefined
        ? (request.workspaceRoots ?? []).map((root) => root.rootId)
        : [request.rootId]),
    status.authorizedRootIds,
    request
  );
  signal?.throwIfAborted();
  const droppedChunks = new Set<string>();
  const readWorktreeFile = request.checkout ? cachedCheckoutReader(request.checkout.read) : null;
  // A read-through source's hits move onto the worktree that still holds them.
  const relocated = async (pool: IndexerSearchResult): Promise<IndexerSearchResult> => {
    if (readThrough.length === 0 || !readWorktreeFile) {
      return pool;
    }
    const moved = await relocateCheckoutHits(pool.hits, readThrough, readWorktreeFile);
    for (const chunkId of moved.dropped) {
      droppedChunks.add(chunkId);
    }
    return { ...pool, hits: moved.hits };
  };
  // Main authorizes only the active index's bindings; verify membership again on every hit.
  const scope = { rootIds };
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
  const embedQuery = request.queryEmbedder;
  if (!embedQuery) {
    refuse('Semantic search has no query embedder.');
  }
  const vector = await embedQuery(
    {
      dimensions: profile.dimensions,
      modelId: profile.modelId,
      modelKey: plan.modelKey,
      query,
    },
    signal
  );
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
        hit.rootId === null ||
        !rootIds.includes(hit.rootId) ||
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
    const fetched = await read();
    validatePool(fetched);
    const pool = await relocated(withoutCredentialHits(fetched));
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
    const pools = await Promise.all(
      arms.map((arm) => {
        if (arm.status !== 'fulfilled') {
          throw new Error('Native search settlement invariant failed.');
        }
        validatePool(arm.value);
        return relocated(withoutCredentialHits(arm.value));
      })
    );
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
  const hint = retrievalHint(
    unindexedNote,
    readThroughNote(readThrough, droppedChunks.size, request.workspaceRoots),
    coverageHint,
    scanLimited,
    truncated
  );
  return {
    assertCurrent,
    ftsResultCount,
    hits,
    limit,
    readThrough,
    truncated,
    vectorResultCount,
    ...(hint ? { hint } : {}),
  };
}

/** Which checkout answered for each worktree, and how many candidate chunks the worktree no longer holds. */
function readThroughNote(
  readThrough: readonly CheckoutReadThrough[],
  dropped: number,
  roots: NativeAssistantRequest['workspaceRoots']
): string | undefined {
  if (readThrough.length === 0) {
    return;
  }
  const pairs = readThrough
    .map(
      (pair) => `${rootName(pair.worktreeRootId, roots)} from ${rootName(pair.sourceRootId, roots)}`
    )
    .join(', ');
  const changed =
    dropped === 0
      ? ''
      : ` ${dropped} ${dropped === 1 ? 'candidate chunk was' : 'candidate chunks were'} left out because the worktree's file differs; grepSearch reads the worktree directly.`;
  return `Worktree results come from the index of another checkout of the same repository, checked against the worktree's files: ${pairs}.${changed}`;
}

function retrievalHint(
  unindexedNote: string | undefined,
  readThroughHint: string | undefined,
  coverageHint: string | undefined,
  scanLimited: boolean,
  truncated: boolean
): string | undefined {
  const hints = [
    unindexedNote === undefined
      ? undefined
      : `Results cover only the indexed folders: ${unindexedNote}`,
    readThroughHint,
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
    profile.provider === undefined
  ) {
    refuse(
      'Native query inference requires the exact saved model, dimensions and distance profile.'
    );
  }
}
