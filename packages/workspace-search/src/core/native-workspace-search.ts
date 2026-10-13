import { calculateRRFContribution, createGrepLineMatcher, RRF_K_DEFAULT } from '@brainstrike/db';
import {
  type IndexerCoverage,
  type IndexerCoverageCounts,
  type IndexerEmbeddingProfile,
  type IndexerEmbeddingState,
  type IndexerSearchHit,
  type IndexerSearchResult,
  type IndexerStatus,
  type IndexSearchCapability,
  indexerEmbeddingProfileValues,
  NativeIndexRefusalError,
  validIndexerEmbeddingProfile,
} from '@brainstrike/indexing-contract/indexer-client';
import type { NativeWorkspaceSearchDependencies } from './native-workspace-search-context';
import type {
  WorkspaceSearchChild,
  WorkspaceSearchFileResult,
  WorkspaceSearchMode,
  WorkspaceSearchResults,
} from './search-result-model';
import { buildGrepPattern } from './workspace-search-executor';

export interface NativeSemanticAvailability {
  available: boolean;
  hint?: string;
  reason: string | null;
}
export interface NativeSearchScope {
  capability: IndexSearchCapability | null;
  collectionId?: string | null;
  profile: IndexerEmbeddingProfile | null;
  profileUnavailableReason?: string;
  rootIds: readonly string[];
}

const validProfile = validIndexerEmbeddingProfile;
const profileValues = indexerEmbeddingProfileValues;
function sameProfile(left: IndexerEmbeddingProfile, right: IndexerEmbeddingProfile): boolean {
  return (
    validProfile(left) &&
    JSON.stringify(profileValues(left)) === JSON.stringify(profileValues(right))
  );
}
async function nativeProfileHash(profile: IndexerEmbeddingProfile): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(profileValues(profile)))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function validCounts(counts: IndexerCoverageCounts): boolean {
  return (
    [counts.chunks, counts.indexedFiles, counts.missingVectors, counts.vectors].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) &&
    counts.vectors + counts.missingVectors === counts.chunks &&
    (counts.chunks === 0 || counts.indexedFiles > 0)
  );
}
function unavailable(reason: string): NativeSemanticAvailability {
  return { available: false, reason };
}

function validCoverageCounts(coverage: IndexerCoverage, rootIds: readonly string[]): boolean {
  const totals = { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 };
  for (const rootId of rootIds) {
    const rows = coverage.roots.filter((root) => root.rootId === rootId);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      !validCounts({
        chunks: row.chunks,
        indexedFiles: row.indexedFiles,
        missingVectors: row.missingVectors,
        vectors: row.vectors,
      })
    ) {
      return false;
    }
    totals.indexedFiles += row.indexedFiles;
    totals.chunks += row.chunks;
    totals.vectors += row.vectors;
    totals.missingVectors += row.missingVectors;
  }
  return (
    validCounts(coverage.totals) &&
    Object.entries(totals).every(
      ([key, value]) => coverage.totals[key as keyof IndexerCoverageCounts] === value
    )
  );
}

function validNativeScope(rootIds: readonly string[], collectionId: string | null): boolean {
  return (rootIds.length > 0 || collectionId !== null) && new Set(rootIds).size === rootIds.length;
}

/** Exact-profile native rows are searchable during ingestion; completion remains a separate proof. */
export async function getNativeSemanticAvailability(
  scope: NativeSearchScope
): Promise<NativeSemanticAvailability> {
  const { capability, profile, rootIds } = scope;
  const collectionId = scope.collectionId ?? null;
  if (!capability) {
    return unavailable('Native vector search is unavailable.');
  }
  if (!(profile && validProfile(profile))) {
    return unavailable(
      scope.profileUnavailableReason ??
        'Vector search requires a complete configured embedding profile.'
    );
  }
  if (!validNativeScope(rootIds, collectionId)) {
    return unavailable('Vector search requires an explicit nonempty workspace root scope.');
  }
  try {
    const observation = await capability.coverageBatch([
      {
        rootIds,
        ...(collectionId === null ? {} : { collectionId }),
      },
    ]);
    if (observation.kind === 'invalidated') {
      return unavailable('Native vector availability is being verified.');
    }
    if (observation.kind === 'blocked') {
      return unavailable(observation.reason);
    }
    const { status } = observation;
    const [coverage] = observation.coverage;
    if (observation.coverage.length !== 1 || !coverage) {
      return unavailable('Native vector availability returned a different coverage inventory.');
    }
    if (status.embedding.indexMode !== 'vector-configured') {
      return unavailable('The native store has no explicitly configured vector profile.');
    }
    const profileHash = await nativeProfileHash(profile);
    if (!matchesConfiguredProfile(status.embedding, profile, profileHash)) {
      return unavailable('Vector search profile does not match the native index.');
    }
    if (collectionId !== null && !status.authorizedCollectionIds?.includes(collectionId)) {
      return unavailable('Native collection scope is not currently authorized.');
    }
    if (rootIds.some((rootId) => !status.authorizedRootIds.includes(rootId))) {
      return unavailable('Vector search scope contains an unauthorized workspace root.');
    }
    const reason = coverageRefusal(
      coverage,
      status.storeId,
      profile,
      profileHash,
      rootIds,
      collectionId
    );
    if (reason !== null) {
      return unavailable(reason);
    }
    return admittedCoverage(coverage, completeScopeReceipts(status, rootIds, collectionId));
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function admittedCoverage(
  coverage: IndexerCoverage,
  sourceComplete: boolean
): NativeSemanticAvailability {
  if (sourceComplete && coverage.vectorCoverageComplete) {
    return { available: true, reason: null };
  }
  const { indexedFiles, chunks, vectors, missingVectors } = coverage.totals;
  return {
    available: true,
    hint: `Partial index coverage observed: ${indexedFiles} files, ${chunks} chunks, ${vectors} vectors, ${missingVectors} chunks awaiting vectors. Source scan ${sourceComplete ? 'complete' : 'incomplete'}; results cover the indexed subset.`,
    reason: null,
  };
}

export const NATIVE_SEARCH_CANDIDATE_LIMIT = 100;
export const NATIVE_SEARCH_FINAL_LIMIT = 10;
export interface NativeSearchPools {
  bm25: IndexerSearchResult | null;
  grep: IndexerSearchResult | null;
  vector?: IndexerSearchResult;
}
export interface NativeFusedHit {
  hit: IndexerSearchHit;
  rrfScore: number;
}
export interface NativeFusedResults {
  candidatesTruncated: boolean;
  hits: NativeFusedHit[];
  scanLimited: boolean;
  truncated: boolean;
}
function hitIdentity(hit: IndexerSearchHit): string {
  return JSON.stringify([
    hit.chunkId,
    hit.rootId,
    hit.fileId,
    hit.relativePath,
    hit.contentHash,
    hit.content,
    hit.startLine,
    hit.endLine,
    hit.chunkIndex,
    hit.chunkSize,
    hit.chunkType,
    hit.startOffset,
    hit.endOffset,
    hit.tokenCount,
  ]);
}
/** Fixed policy from the judged measurement: named streams, RRF60, 100 candidates, final10. */
export interface NativeSearchIdentity {
  readonly embedding: IndexerEmbeddingState;
  readonly storeId: string;
}
function embeddingIdentity(embedding: IndexerEmbeddingState): string {
  return JSON.stringify(
    embedding.indexMode === 'text-only'
      ? ['text-only']
      : ['vector-configured', ...profileValues(embedding.profile), embedding.profileHash]
  );
}
export function fuseNativeSearchPools(
  pools: NativeSearchPools,
  identity: NativeSearchIdentity,
  acceptHit: (hit: IndexerSearchHit) => boolean = () => true
): NativeFusedResults {
  if (!(pools.bm25 && pools.grep)) {
    throw new Error('Native fusion requires the BM25 and grep candidate pools.');
  }
  const sources = [pools.bm25, pools.grep, ...(pools.vector ? [pools.vector] : [])];
  const fused = new Map<string, NativeFusedHit>();
  for (const source of sources) {
    if (
      source.storeId !== identity.storeId ||
      embeddingIdentity(source.embedding) !== embeddingIdentity(identity.embedding)
    ) {
      throw new Error(
        'Native candidate pool store and embedding identity do not match the ready index.'
      );
    }
    if (source.hits.length > NATIVE_SEARCH_CANDIDATE_LIMIT) {
      throw new Error('Native candidate pool exceeds the explicit candidate limit.');
    }
    const contributed = new Set<string>();
    source.hits.forEach((hit, index) => {
      const prior = fused.get(hit.chunkId);
      if (prior && hitIdentity(prior.hit) !== hitIdentity(hit)) {
        throw new Error('Native candidate pools disagree about a source chunk identity.');
      }
      if (contributed.has(hit.chunkId)) {
        return;
      }
      contributed.add(hit.chunkId);
      const contribution = calculateRRFContribution(index + 1, RRF_K_DEFAULT);
      if (prior) {
        prior.rrfScore += contribution;
      } else {
        fused.set(hit.chunkId, { hit, rrfScore: contribution });
      }
    });
  }
  const ranked = Array.from(fused.values())
    .filter(({ hit }) => acceptHit(hit))
    .sort(
      (left, right) =>
        right.rrfScore - left.rrfScore || left.hit.chunkId.localeCompare(right.hit.chunkId)
    );
  return {
    candidatesTruncated: sources.some((source) => source.candidatesTruncated),
    hits: ranked.slice(0, NATIVE_SEARCH_FINAL_LIMIT),
    scanLimited: sources.some((source) => source.scanLimited),
    truncated:
      ranked.length > NATIVE_SEARCH_FINAL_LIMIT || sources.some((source) => source.truncated),
  };
}

export interface NativeWorkspaceSearchRequest {
  caseSensitive: boolean;
  collectionId: string | null;
  isRegex: boolean;
  query: string;
  rootIds: readonly string[];
  wholeWord: boolean;
}
function emptyNativeResults(mode: WorkspaceSearchMode): WorkspaceSearchResults {
  return {
    files: [],
    mode,
    notices: {
      candidatesTruncated: false,
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      truncated: false,
    },
    totalMatches: 0,
  };
}
function nativeStatusFailure(status: Extract<IndexerStatus, { kind: 'unavailable' }>): Error {
  return status.cause
    ? new NativeIndexRefusalError(status.cause, status.reason)
    : new Error(status.reason);
}
export class NativeWorkspaceSearchExecutor {
  private requestSeq = 0;
  private inferenceController: AbortController | undefined;
  constructor(private readonly deps: NativeWorkspaceSearchDependencies) {}
  cancelPendingSearch(): void {
    this.requestSeq += 1;
    this.inferenceController?.abort(new Error('Native semantic search cancelled.'));
  }
  searchText(request: NativeWorkspaceSearchRequest): Promise<WorkspaceSearchResults | null> {
    return this.search(request, 'text');
  }
  searchSemantic(request: NativeWorkspaceSearchRequest): Promise<WorkspaceSearchResults | null> {
    return this.search(request, 'semantic');
  }
  private async prepareVector(
    request: NativeWorkspaceSearchRequest,
    capability: IndexSearchCapability,
    profile: IndexerEmbeddingProfile | null,
    seq: number
  ): Promise<readonly number[] | null> {
    if (!(profile && validProfile(profile))) {
      throw new Error(
        this.deps.profileUnavailableReason ??
          'Vector search requires a complete configured embedding profile.'
      );
    }
    const scope = {
      capability,
      collectionId: request.collectionId,
      profile,
      rootIds: request.rootIds,
    };
    const availability = await getNativeSemanticAvailability(scope);
    if (seq !== this.requestSeq) {
      return null;
    }
    if (!availability.available) {
      throw new Error(availability.reason ?? 'Native vector search is unavailable.');
    }
    const controller = new AbortController();
    this.inferenceController = controller;
    let vector: readonly number[];
    try {
      vector = await this.deps.embedQuery(profile, request.query, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && error === controller.signal.reason) {
        return null;
      }
      throw error;
    } finally {
      if (this.inferenceController === controller) {
        this.inferenceController = undefined;
      }
    }
    if (seq !== this.requestSeq) {
      return null;
    }
    if (
      vector.length !== profile.dimensions ||
      vector.some((value) => !Number.isFinite(value)) ||
      vector.every((value) => value === 0)
    ) {
      throw new Error('The renderer embedding host returned an invalid query vector.');
    }
    // Inference can outlive a new scan or text replacement. Recheck before any candidate arm runs.
    const current = await getNativeSemanticAvailability(scope);
    if (seq !== this.requestSeq) {
      return null;
    }
    if (!current.available) {
      throw new Error(current.reason ?? 'Native vector search is unavailable.');
    }
    return vector;
  }
  private async search(
    request: NativeWorkspaceSearchRequest,
    mode: WorkspaceSearchMode
  ): Promise<WorkspaceSearchResults | null> {
    this.cancelPendingSearch();
    const seq = this.requestSeq;
    const empty = emptyScopeResult(request, mode);
    if (empty !== null) {
      return empty;
    }
    const { capability, profile } = this.deps;
    if (!capability) {
      throw new Error('Native workspace search is unavailable.');
    }
    const status = await capability.status();
    if (seq !== this.requestSeq) {
      return null;
    }
    if (status.kind !== 'ready') {
      throw nativeStatusFailure(status);
    }
    assertNativeStatusScope(status, request.rootIds, request.collectionId);
    const vector =
      mode === 'semantic' ? await this.prepareVector(request, capability, profile, seq) : undefined;
    if (vector === null || seq !== this.requestSeq) {
      return null;
    }
    const { pattern, isRegex } = buildGrepPattern(request);
    const queryScope = {
      rootIds: request.rootIds,
      ...(request.collectionId === null ? {} : { collectionId: request.collectionId }),
    };
    const sourceRequests = [
      capability.search({
        limit: NATIVE_SEARCH_CANDIDATE_LIMIT,
        mode: 'bm25',
        ...queryScope,
        text: request.query,
      }),
      capability.grep({
        caseSensitive: request.caseSensitive,
        isRegex,
        limit: NATIVE_SEARCH_CANDIDATE_LIMIT,
        pattern,
        ...queryScope,
      }),
    ];
    if (vector) {
      sourceRequests.push(
        capability.search({
          limit: NATIVE_SEARCH_CANDIDATE_LIMIT,
          mode: 'vector',
          profile: requireConfiguredVectorProfile(profile),
          ...(request.collectionId === null ? {} : { collectionId: request.collectionId }),
          rootIds: request.rootIds,
          vector,
        })
      );
    }
    const [bm25, grep, vectorPool] = await Promise.all(sourceRequests);
    if (seq !== this.requestSeq) {
      return null;
    }
    if (!(bm25 && grep) || (mode === 'semantic' && !vectorPool)) {
      throw new Error('Native search did not return every requested candidate pool.');
    }
    assertCandidateScopes(
      [bm25, grep, ...(vectorPool ? [vectorPool] : [])],
      request.rootIds,
      request.collectionId
    );
    const matcher = createGrepLineMatcher(pattern, isRegex, request.caseSensitive);
    const constrained = request.isRegex || request.caseSensitive || request.wholeWord;
    const fused = fuseNativeSearchPools(
      { bm25, grep, ...(vectorPool ? { vector: vectorPool } : {}) },
      status,
      (hit) => !constrained || hit.content.split('\n').some((line) => matcher.matches(line))
    );
    return projectNativeResults(fused, grep, request, mode, matcher, constrained);
  }
}

function projectNativeResults(
  fused: NativeFusedResults,
  grep: IndexerSearchResult,
  request: NativeWorkspaceSearchRequest,
  mode: WorkspaceSearchMode,
  matcher: ReturnType<typeof createGrepLineMatcher>,
  constrained: boolean
): WorkspaceSearchResults {
  const grepIds = new Set(grep.hits.map((hit) => hit.chunkId));
  const groups = new Map<string, WorkspaceSearchFileResult>();
  const maxScore = fused.hits[0]?.rrfScore ?? 1;
  for (const { hit, rrfScore } of fused.hits) {
    assertCanonicalHit(hit, request.rootIds, request.collectionId);
    const children: WorkspaceSearchChild[] =
      mode === 'text' && (constrained || grepIds.has(hit.chunkId))
        ? nativeLineMatches(hit, matcher)
        : [
            {
              chunkId: hit.chunkId,
              content: hit.content,
              endLine: hit.endLine,
              headline: null,
              kind: 'chunk',
              provenance: 'index',
              score: rrfScore / maxScore,
              startLine: hit.startLine,
              tokenCount: hit.tokenCount,
            },
          ];
    if (children.length === 0) {
      throw new Error('The native grep pool returned a chunk without a canonical line match.');
    }
    const key = JSON.stringify([hit.rootId, hit.fileId]);
    const prior = groups.get(key);
    if (prior) {
      groups.set(key, { ...prior, children: [...prior.children, ...children] });
    } else {
      groups.set(key, {
        children,
        dbRootId: hit.rootId,
        fileRecordId: hit.fileId,
        path: hit.relativePath ?? hit.sourcePath ?? hit.fileId,
        rootDisplayName: null,
      });
    }
  }
  return {
    files: Array.from(groups.values()),
    mode,
    notices: {
      candidatesTruncated: fused.candidatesTruncated,
      scanLimited: fused.scanLimited,
      skippedMissingLineMetadata: 0,
      truncated: fused.truncated,
    },
    totalMatches: Array.from(groups.values()).reduce(
      (total, file) => total + file.children.length,
      0
    ),
  };
}

function assertNativeStatusScope(
  status: Extract<Awaited<ReturnType<IndexSearchCapability['status']>>, { kind: 'ready' }>,
  rootIds: readonly string[],
  collectionId: string | null
): void {
  if (collectionId !== null && !status.authorizedCollectionIds?.includes(collectionId)) {
    throw new Error('Native collection search is not currently authorized.');
  }
  if (rootIds.some((rootId) => !status.authorizedRootIds.includes(rootId))) {
    throw new Error('Native search scope contains an unauthorized workspace root.');
  }
}
function assertCanonicalHit(
  hit: IndexerSearchHit,
  rootIds: readonly string[],
  collectionId: string | null
): asserts hit is IndexerSearchHit & { tokenCount: number } {
  if (
    !(
      (collectionId === null
        ? hit.rootId !== null && rootIds.includes(hit.rootId)
        : hit.embeddingSetId === collectionId) && Number.isSafeInteger(hit.tokenCount)
    ) ||
    hit.tokenCount === null ||
    hit.tokenCount <= 0 ||
    !Number.isSafeInteger(hit.startLine) ||
    hit.startLine <= 0 ||
    !Number.isSafeInteger(hit.endLine) ||
    hit.endLine < hit.startLine
  ) {
    throw new Error('Native search returned a chunk outside its canonical source scope.');
  }
}

function assertCandidateScopes(
  pools: readonly IndexerSearchResult[],
  rootIds: readonly string[],
  collectionId: string | null
): void {
  for (const pool of pools) {
    for (const hit of pool.hits) {
      assertCanonicalHit(hit, rootIds, collectionId);
    }
  }
}

function requireConfiguredVectorProfile(
  profile: IndexerEmbeddingProfile | null
): IndexerEmbeddingProfile {
  if (!(profile && validProfile(profile))) {
    throw new Error('Vector search requires a complete configured embedding profile.');
  }
  return profile;
}

function matchesConfiguredProfile(
  embedding: IndexerEmbeddingState,
  profile: IndexerEmbeddingProfile,
  profileHash: string
): boolean {
  return (
    embedding.indexMode === 'vector-configured' &&
    sameProfile(embedding.profile, profile) &&
    embedding.profileHash === profileHash
  );
}

function nativeLineMatches(
  hit: IndexerSearchHit,
  matcher: ReturnType<typeof createGrepLineMatcher>
): WorkspaceSearchChild[] {
  const lines = hit.content.split('\n');
  return lines.flatMap((lineText, index) =>
    matcher.matches(lineText)
      ? [
          {
            after: lines.slice(index + 1, index + 2),
            before: lines.slice(Math.max(0, index - 1), index),
            chunkEndLine: hit.endLine,
            chunkId: hit.chunkId,
            chunkStartLine: hit.startLine,
            kind: 'match' as const,
            line: hit.startLine + index,
            lineText,
            provenance: 'index' as const,
          },
        ]
      : []
  );
}

function completeScopeReceipts(
  status: Extract<Awaited<ReturnType<IndexSearchCapability['status']>>, { kind: 'ready' }>,
  rootIds: readonly string[],
  collectionId: string | null
): boolean {
  if (collectionId !== null) {
    const receipts = status.collectionReadiness?.filter(
      (receipt) => receipt.embeddingSetId === collectionId
    );
    return receipts?.length === 1 && receipts[0]?.scanComplete === true;
  }
  return rootIds.every((rootId) => {
    const receipts = status.rootReadiness.filter((receipt) => receipt.rootId === rootId);
    return receipts.length === 1 && receipts[0]?.scanComplete === true;
  });
}
function coverageRefusal(
  coverage: IndexerCoverage,
  storeId: string,
  profile: IndexerEmbeddingProfile,
  profileHash: string,
  rootIds: readonly string[],
  collectionId: string | null
): string | null {
  if (
    coverage.storeId !== storeId ||
    !matchesConfiguredProfile(coverage.embedding, profile, profileHash)
  ) {
    return 'Vector coverage profile does not match the configured profile.';
  }
  const expectedScopeCount =
    collectionId === null
      ? coverage.roots.length === rootIds.length
      : coverage.collections?.length === 1;
  if (
    !expectedScopeCount ||
    coverage.totals.vectors === 0 ||
    (coverage.vectorCoverageComplete && coverage.totals.missingVectors !== 0)
  ) {
    return 'Vector coverage is incomplete for the requested workspace roots.';
  }
  const complete =
    collectionId === null
      ? validCoverageCounts(coverage, rootIds)
      : validCollectionCounts(coverage, collectionId);
  return complete ? null : 'Native vector coverage totals are inconsistent or incomplete.';
}
function validCollectionCounts(coverage: IndexerCoverage, collectionId: string): boolean {
  const collection = coverage.collections?.find((row) => row.embeddingSetId === collectionId);
  return (
    !!collection &&
    validCounts(collection) &&
    validCounts(coverage.totals) &&
    Object.entries(coverage.totals).every(
      ([key, value]) => collection[key as keyof IndexerCoverageCounts] === value
    )
  );
}

function emptyScopeResult(
  request: NativeWorkspaceSearchRequest,
  mode: WorkspaceSearchMode
): WorkspaceSearchResults | null {
  if (request.rootIds.length !== 0 || request.collectionId !== null) {
    return null;
  }
  if (mode === 'text') {
    return emptyNativeResults(mode);
  }
  throw new Error('Vector search requires an explicit nonempty workspace root scope.');
}
