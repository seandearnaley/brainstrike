/**
 * The retrieval tools' semantic availability gate and candidate-pool fusion
 * over Main's native index: RRF60 across the BM25, grep and vector pools,
 * 100 candidates, final 10. Only `native-assistant-retrieval.ts` reads it.
 */
import {
  type IndexerCoverage,
  type IndexerCoverageCounts,
  type IndexerEmbeddingProfile,
  type IndexerEmbeddingState,
  type IndexerSearchHit,
  type IndexerSearchResult,
  type IndexSearchCapability,
  indexerEmbeddingProfileValues,
  NO_WORKSPACE_FOLDER_MESSAGE,
  validIndexerEmbeddingProfile,
} from '@brainstrike/indexing-contract/indexer-client';
import { calculateRRFContribution, RRF_K_DEFAULT } from '@brainstrike/utils/rrf';

interface NativeSemanticAvailability {
  available: boolean;
  hint?: string;
  reason: string | null;
}
interface NativeSearchScope {
  capability: IndexSearchCapability | null;
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

/** Exact-profile native rows are searchable during ingestion; completion remains a separate proof. */
export async function getNativeSemanticAvailability(
  scope: NativeSearchScope
): Promise<NativeSemanticAvailability> {
  const { capability, profile, rootIds } = scope;
  if (!capability) {
    return unavailable('Native vector search is unavailable.');
  }
  if (!(profile && validProfile(profile))) {
    return unavailable(
      scope.profileUnavailableReason ??
        'Vector search requires a complete configured embedding profile.'
    );
  }
  if (rootIds.length === 0) {
    return unavailable(NO_WORKSPACE_FOLDER_MESSAGE);
  }
  if (new Set(rootIds).size !== rootIds.length) {
    return unavailable('Vector search was asked for the same workspace folder twice.');
  }
  const observation = await capability.coverageBatch([{ rootIds }]);
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
  if (rootIds.some((rootId) => !status.authorizedRootIds.includes(rootId))) {
    return unavailable('Vector search scope contains an unauthorized workspace root.');
  }
  const reason = coverageRefusal(coverage, status.storeId, profile, profileHash, rootIds);
  if (reason !== null) {
    return unavailable(reason);
  }
  return admittedCoverage(coverage, completeScopeReceipts(status, rootIds));
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
interface NativeSearchPools {
  bm25: IndexerSearchResult | null;
  grep: IndexerSearchResult | null;
  vector?: IndexerSearchResult;
}
interface NativeFusedHit {
  hit: IndexerSearchHit;
  rrfScore: number;
}
interface NativeFusedResults {
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
interface NativeSearchIdentity {
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

function completeScopeReceipts(
  status: Extract<Awaited<ReturnType<IndexSearchCapability['status']>>, { kind: 'ready' }>,
  rootIds: readonly string[]
): boolean {
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
  rootIds: readonly string[]
): string | null {
  if (
    coverage.storeId !== storeId ||
    !matchesConfiguredProfile(coverage.embedding, profile, profileHash)
  ) {
    return 'Vector coverage profile does not match the configured profile.';
  }
  if (
    coverage.roots.length !== rootIds.length ||
    coverage.totals.vectors === 0 ||
    (coverage.vectorCoverageComplete && coverage.totals.missingVectors !== 0)
  ) {
    return 'Vector coverage is incomplete for the requested workspace roots.';
  }
  return validCoverageCounts(coverage, rootIds)
    ? null
    : 'Native vector coverage totals are inconsistent or incomplete.';
}
