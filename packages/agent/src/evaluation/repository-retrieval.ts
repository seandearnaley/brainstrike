import { createHash } from 'node:crypto';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { calculateRRFContribution, RRF_K_DEFAULT } from '@brainstrike/utils/rrf';
import { Schema } from 'effect';
import { aggregateMetrics, evaluateTestCase } from './metrics';
import type { AggregateMetrics, TestCaseResult } from './types';

const sourceSchema = Schema.Struct({
  relativePath: Schema.String.check(Schema.isMinCodePoints(1)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const judgmentSchema = Schema.Struct({
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
  evidence: Schema.String.check(Schema.isMinCodePoints(1)),
  id: Schema.String.check(Schema.isMinCodePoints(1)),
  rationale: Schema.String.check(Schema.isMinCodePoints(1)),
  relativePath: Schema.String.check(Schema.isMinCodePoints(1)),
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const repositoryRetrievalFixtureSchema = Schema.Struct({
  judgmentMethod: Schema.String.check(Schema.isMinCodePoints(1)),
  name: Schema.String.check(Schema.isMinCodePoints(1)),
  queries: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isMinCodePoints(1)),
        intent: Schema.String.check(Schema.isMinCodePoints(1)),
        judgments: Schema.mutable(Schema.Array(judgmentSchema)).check(Schema.isMinLength(1)),
        kind: Schema.Literals(['exact', 'fuzzy', 'semantic', 'mixed']),
        query: Schema.String.check(Schema.isMinCodePoints(1)),
      })
    )
  ).check(Schema.isMinLength(1)),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  sources: Schema.mutable(Schema.Array(sourceSchema)).check(Schema.isMinLength(1)),
  version: Schema.String.check(Schema.isMinCodePoints(1)),
});
export type RepositoryRetrievalFixture = (typeof repositoryRetrievalFixtureSchema)['Type'];
export type JudgedQuery = RepositoryRetrievalFixture['queries'][number];
export type RetrievalArm = 'bm25' | 'grep' | 'trigram' | 'vector';
export type EvaluationMode = RetrievalArm | 'lexical' | 'hybrid';
export interface EvaluationHit {
  chunkId: string;
  content: string;
  endLine: number;
  endOffset?: number;
  relativePath: string;
  score: number;
  startLine: number;
  startOffset?: number;
}
export interface CandidatePool {
  candidateCount: number;
  hits: EvaluationHit[];
  profileHash: string;
}
export interface EvaluationEmbeddingProfile {
  device: 'wasm' | 'webgpu';
  dimensions: 384;
  dtype: 'q8' | 'fp16' | 'fp32';
  modelId: string;
  normalization: 'l2';
  pooling: 'mean' | 'cls';
  revision: string;
  tokenCap: number;
}
const embeddingProfileSchema = Schema.Struct({
  device: Schema.Literals(['wasm', 'webgpu']),
  dimensions: Schema.Literal(384),
  dtype: Schema.Literals(['q8', 'fp16', 'fp32']),
  modelId: Schema.String.check(Schema.isMinCodePoints(1)),
  normalization: Schema.Literal('l2'),
  pooling: Schema.Literals(['mean', 'cls']),
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  tokenCap: Schema.Int.check(Schema.isGreaterThan(0)),
});
export function validateFixtureSources(
  fixture: RepositoryRetrievalFixture,
  readSource: (path: string) => string
): void {
  const contents = new Map<string, string>();
  for (const source of fixture.sources) {
    const content = readSource(source.relativePath);
    if (createHash('sha256').update(content).digest('hex') !== source.sha256) {
      throw new Error(`Fixture source hash changed: ${source.relativePath}`);
    }
    contents.set(source.relativePath, content);
  }
  const queryIds = new Set<string>();
  const queryTexts = new Set<string>();
  for (const query of fixture.queries) {
    if (queryIds.has(query.id) || queryTexts.has(query.query)) {
      throw new Error(`Duplicate fixture query: ${query.id}`);
    }
    queryIds.add(query.id);
    queryTexts.add(query.query);
    const judgmentIds = new Set<string>();
    for (const judgment of query.judgments) {
      const lines = contents.get(judgment.relativePath)?.split('\n');
      if (!lines || judgment.endLine < judgment.startLine || judgment.endLine > lines.length) {
        throw new Error(`Invalid judgment span: ${judgment.id}`);
      }
      if (judgmentIds.has(judgment.id)) {
        throw new Error(`Duplicate judgment: ${judgment.id}`);
      }
      judgmentIds.add(judgment.id);
      if (
        !lines
          .slice(judgment.startLine - 1, judgment.endLine)
          .join('\n')
          .includes(judgment.evidence)
      ) {
        throw new Error(`Judgment evidence missing: ${judgment.id}`);
      }
    }
  }
}
function uniqueHits(hits: readonly EvaluationHit[]): EvaluationHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.chunkId)) {
      return false;
    }
    seen.add(hit.chunkId);
    return true;
  });
}
/** Reuses existing IR metrics with judged source spans as answer identities. */
export function evaluateJudgedHits(
  query: JudgedQuery,
  hits: readonly EvaluationHit[],
  executionTimeMs = 0
): TestCaseResult {
  const results = uniqueHits(hits).map((hit, index) => {
    const judgment = query.judgments.find(
      (answer) =>
        answer.relativePath === hit.relativePath &&
        hit.startLine <= answer.endLine &&
        hit.endLine >= answer.startLine &&
        hit.content.includes(answer.evidence)
    );
    return {
      content: hit.content,
      filePath: judgment?.id ?? `unjudged:${hit.chunkId}`,
      rank: index + 1,
      // Internal metric adapter value, not a native score; similarity has no threshold.
      similarity: 1,
    };
  });
  return evaluateTestCase(
    {
      expectedFilePaths: query.judgments.map((answer) => answer.id),
      id: query.id,
      query: query.query,
    },
    results,
    [1, 3, 5, 10],
    executionTimeMs
  );
}
/** Equal-weight RRF over named streams; a missing stream is an error. */
export function fuseEvaluationHits(
  pools: Partial<Record<RetrievalArm, readonly EvaluationHit[]>>,
  arms: readonly RetrievalArm[],
  limit: number
): EvaluationHit[] {
  const entries = new Map<string, EvaluationHit>();
  for (const arm of arms) {
    const hits = pools[arm];
    if (!hits) {
      throw new Error(`Missing evaluation candidate source: ${arm}`);
    }
    const seen = new Set<string>();
    for (const [index, hit] of hits.entries()) {
      if (seen.has(hit.chunkId)) {
        continue;
      }
      seen.add(hit.chunkId);
      const contribution = calculateRRFContribution(index + 1, RRF_K_DEFAULT);
      entries.set(hit.chunkId, {
        ...hit,
        score: (entries.get(hit.chunkId)?.score ?? 0) + contribution,
      });
    }
  }
  return [...entries.values()]
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
    .slice(0, limit);
}
export interface ComparableMetrics {
  mrr: number;
  recallAt10: number;
}
export function checkRetrievalImprovement(
  baseline: ComparableMetrics,
  hybrid: ComparableMetrics
): { passed: boolean; recallDelta: number; mrrDelta: number } {
  for (const metric of [...Object.values(baseline), ...Object.values(hybrid)]) {
    if (!(Number.isFinite(metric) && metric >= 0 && metric <= 1)) {
      throw new Error('Retrieval metric must be finite and within [0, 1]');
    }
  }
  const recallDelta = hybrid.recallAt10 - baseline.recallAt10;
  const mrrDelta = hybrid.mrr - baseline.mrr;
  return {
    mrrDelta,
    // Account only for binary subtraction rounding at the exact 0.05 boundary.
    passed:
      recallDelta >= 0 &&
      mrrDelta >= 0 &&
      (recallDelta + Number.EPSILON >= 0.05 || mrrDelta + Number.EPSILON >= 0.05),
    recallDelta,
  };
}
const ARMS: readonly RetrievalArm[] = ['bm25', 'grep', 'trigram', 'vector'];
const MODES: readonly EvaluationMode[] = [...ARMS, 'lexical', 'hybrid'];
const chunkingPolicySchema = Schema.Union(
  [
    Schema.Struct({
      chunkLines: Schema.Int.check(Schema.isGreaterThan(0)),
      kind: Schema.Literal('line'),
    }),
    Schema.Struct({
      kind: Schema.Literal('canonical-host'),
      maxTokens: Schema.Int.check(Schema.isGreaterThan(0)),
      maxTokensCap: Schema.Int.check(Schema.isGreaterThan(0)),
      overlap: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      producerSourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
      tokenTrueSizing: Schema.Boolean,
    }),
  ],
  { mode: 'oneOf' }
);
export type EvaluationChunkingPolicy = (typeof chunkingPolicySchema)['Type'];
export interface RepositoryEvaluationOptions {
  chunking: EvaluationChunkingPolicy;
  corpusSources: RepositoryRetrievalFixture['sources'];
  profile: EvaluationEmbeddingProfile;
  profileHash: string;
  readSource: (relativePath: string) => string;
  search: (arm: RetrievalArm, query: string, limit: number) => Promise<CandidatePool>;
}
export interface RepositoryEvaluationReport {
  candidateLimit: 100;
  chunking: EvaluationChunkingPolicy;
  corpusSources: RepositoryRetrievalFixture['sources'];
  finalLimit: 10;
  fixture: { name: string; version: string; sha256: string; sourceCommit: string };
  gate: ReturnType<typeof checkRetrievalImprovement>;
  modes: Record<EvaluationMode, AggregateMetrics>;
  profile: EvaluationEmbeddingProfile;
  profileHash: string;
  queries: {
    id: string;
    pools: Record<RetrievalArm, CandidatePool>;
    rankings: Record<EvaluationMode, EvaluationHit[]>;
    candidateSearchMs: Record<RetrievalArm, number>;
  }[];
  rrfK: number;
}
function prepareCorpus(
  fixture: RepositoryRetrievalFixture,
  options: RepositoryEvaluationOptions
): Map<string, string> {
  const corpus = new Map(
    options.corpusSources.map((source) => [source.relativePath, source.sha256])
  );
  const sources = new Map<string, string>();
  for (const source of [...options.corpusSources, ...fixture.sources]) {
    const content = options.readSource(source.relativePath);
    if (
      corpus.get(source.relativePath) !== source.sha256 ||
      createHash('sha256').update(content).digest('hex') !== source.sha256
    ) {
      throw new Error(`Evaluation corpus source mismatch: ${source.relativePath}`);
    }
    sources.set(source.relativePath, content);
  }
  return sources;
}
function validateCandidatePool(
  pool: CandidatePool,
  profileHash: string,
  sources: ReadonlyMap<string, string>,
  chunking: EvaluationChunkingPolicy,
  arm: RetrievalArm,
  queryId: string
): void {
  if (
    pool.profileHash !== profileHash ||
    pool.hits.length > 100 ||
    !Number.isSafeInteger(pool.candidateCount) ||
    pool.candidateCount < pool.hits.length
  ) {
    throw new Error(`Invalid ${arm} candidate pool for ${queryId}`);
  }
  for (const hit of pool.hits) {
    const source = sources.get(hit.relativePath);
    const lines = source?.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    const validContent =
      chunking.kind === 'canonical-host'
        ? typeof source === 'string' &&
          Number.isSafeInteger(hit.startOffset) &&
          Number.isSafeInteger(hit.endOffset) &&
          hit.startOffset !== undefined &&
          hit.endOffset !== undefined &&
          hit.startOffset >= 0 &&
          hit.endOffset > hit.startOffset &&
          hit.endOffset <= source.length &&
          source.slice(hit.startOffset, hit.endOffset) === hit.content &&
          (source.slice(0, hit.startOffset).match(/\n/gu)?.length ?? 0) + 1 === hit.startLine &&
          (source.slice(0, hit.endOffset - 1).match(/\n/gu)?.length ?? 0) + 1 === hit.endLine
        : hit.content === lines.slice(hit.startLine - 1, hit.endLine).join('');
    if (
      !(
        typeof source === 'string' &&
        Number.isSafeInteger(hit.startLine) &&
        Number.isSafeInteger(hit.endLine)
      ) ||
      hit.startLine < 1 ||
      hit.endLine < hit.startLine ||
      hit.endLine > lines.length ||
      !Number.isFinite(hit.score) ||
      !validContent
    ) {
      throw new Error(`Invalid ${arm} source hit for ${queryId}: ${hit.chunkId}`);
    }
  }
}
function rankCandidatePools(
  pools: Record<RetrievalArm, CandidatePool>
): Record<EvaluationMode, EvaluationHit[]> {
  return {
    bm25: uniqueHits(pools.bm25.hits).slice(0, 10),
    grep: uniqueHits(pools.grep.hits).slice(0, 10),
    hybrid: fuseEvaluationHits(
      { bm25: pools.bm25.hits, grep: pools.grep.hits, vector: pools.vector.hits },
      ['bm25', 'grep', 'vector'],
      10
    ),
    lexical: fuseEvaluationHits(
      { bm25: pools.bm25.hits, grep: pools.grep.hits },
      ['bm25', 'grep'],
      10
    ),
    trigram: uniqueHits(pools.trigram.hits).slice(0, 10),
    vector: uniqueHits(pools.vector.hits).slice(0, 10),
  };
}
function candidateGenerationMs(mode: EvaluationMode, times: Record<RetrievalArm, number>): number {
  if (mode === 'hybrid') {
    return times.bm25 + times.grep + times.vector;
  }
  if (mode === 'lexical') {
    return times.bm25 + times.grep;
  }
  return times[mode];
}
export async function runRepositoryRetrievalEvaluation(
  fixture: RepositoryRetrievalFixture,
  options: RepositoryEvaluationOptions
): Promise<RepositoryEvaluationReport> {
  wireDecoder(embeddingProfileSchema, { errors: 'all' })(options.profile);
  if (!/^[a-f0-9]{64}$/u.test(options.profileHash)) {
    throw new Error('Invalid evaluation profile hash');
  }
  validateFixtureSources(fixture, options.readSource);
  wireDecoder(chunkingPolicySchema, { errors: 'all' })(options.chunking);
  if (options.corpusSources.length === 0) {
    throw new Error('Evaluation corpus must be explicit and nonempty');
  }
  const sources = prepareCorpus(fixture, options);
  const perMode: Record<EvaluationMode, TestCaseResult[]> = {
    bm25: [],
    grep: [],
    hybrid: [],
    lexical: [],
    trigram: [],
    vector: [],
  };
  const queryReports: RepositoryEvaluationReport['queries'] = [];
  for (const query of fixture.queries) {
    const pools = {} as Record<RetrievalArm, CandidatePool>;
    const candidateSearchMs = {} as Record<RetrievalArm, number>;
    for (const arm of ARMS) {
      const startedAt = performance.now();
      const pool = await options.search(arm, query.query, 100);
      candidateSearchMs[arm] = performance.now() - startedAt;
      validateCandidatePool(pool, options.profileHash, sources, options.chunking, arm, query.id);
      pools[arm] = pool;
    }
    const rankings = rankCandidatePools(pools);
    for (const mode of MODES) {
      perMode[mode].push(
        evaluateJudgedHits(query, rankings[mode], candidateGenerationMs(mode, candidateSearchMs))
      );
    }
    queryReports.push({ candidateSearchMs, id: query.id, pools, rankings });
  }
  const modes = Object.fromEntries(
    MODES.map((mode) => [mode, aggregateMetrics(perMode[mode], [1, 3, 5, 10])])
  ) as Record<EvaluationMode, AggregateMetrics>;
  const compare = (metrics: AggregateMetrics): ComparableMetrics => ({
    mrr: metrics.meanMrr,
    recallAt10: metrics.meanRecallAtK[10] ?? 0,
  });
  return {
    candidateLimit: 100,
    chunking: options.chunking,
    corpusSources: options.corpusSources,
    finalLimit: 10,
    fixture: {
      name: fixture.name,
      sha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
      sourceCommit: fixture.sourceCommit,
      version: fixture.version,
    },
    gate: checkRetrievalImprovement(compare(modes.lexical), compare(modes.hybrid)),
    modes,
    profile: options.profile,
    profileHash: options.profileHash,
    queries: queryReports,
    rrfK: RRF_K_DEFAULT,
  };
}
