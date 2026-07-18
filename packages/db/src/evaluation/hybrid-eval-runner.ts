import { countTokensHeuristic } from '@brainstrike/utils/token-counting-heuristics';
import type { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrations/bootstrap.js';
import type { FileChunkInsert } from '../models/file-chunk.js';
import { EmbeddingSetsRepository } from '../repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../repositories/file-record-repository.js';
import { HybridSearchService } from '../search/hybrid-search-service.js';
import { wasmLoader } from '../wasm-loader.js';
import { type HybridGoldenDataset, hybridGoldenDataset } from './hybrid-golden.js';

const NOW = new Date(0).toISOString();
const DEFAULT_LIMIT = 10;
const VECTOR_THRESHOLD = 0.5;

export interface HybridEvaluationThresholds {
  minMeanPrecisionAt1: number;
  minMeanReciprocalRank: number;
}

export interface HybridEvaluationArmScore {
  meanPrecisionAt1: number;
  meanReciprocalRank: number;
}

export interface HybridEvaluationQueryResult {
  expectedChunkId: string;
  hybridTopChunkIds: string[];
  id: string;
  lexicalOnlyTopChunkIds: string[];
  passed: boolean;
  precisionAt1: number;
  query: string;
  /** 1/rank of the expected chunk in the fused list; 0 when absent. */
  reciprocalRank: number;
  vectorOnlyTopChunkIds: string[];
}

export interface HybridEvaluationReport {
  arms: {
    hybrid: HybridEvaluationArmScore;
    lexicalOnly: HybridEvaluationArmScore;
    vectorOnly: HybridEvaluationArmScore;
  };
  dataset: {
    name: string;
    version: string;
  };
  failures: string[];
  passed: boolean;
  queries: HybridEvaluationQueryResult[];
  summary: {
    failureCount: number;
    failedQueries: number;
    meanPrecisionAt1: number;
    meanReciprocalRank: number;
    passedQueries: number;
    totalQueries: number;
  };
  thresholds: HybridEvaluationThresholds;
  timestamp: string;
}

export interface RunHybridEvaluationOptions {
  dataset?: HybridGoldenDataset;
  thresholds?: Partial<HybridEvaluationThresholds>;
}

/**
 * Strict like the vector and lexical evals: the golden corpus is hand-designed
 * so RRF fusion must place every expected chunk first — even though (by
 * construction, also asserted below) neither pure arm does.
 */
const DEFAULT_THRESHOLDS: HybridEvaluationThresholds = {
  minMeanPrecisionAt1: 1,
  minMeanReciprocalRank: 1,
};

async function seedGoldenFiles(
  chunkRepo: FileChunkRepository,
  fileRepo: FileRecordRepository,
  files: readonly HybridGoldenDataset['files'][number][],
  embeddingSetId: string
): Promise<void> {
  const chunkInserts: FileChunkInsert[] = [];
  for (const goldenFile of files) {
    await fileRepo.create({
      createdAt: NOW,
      id: goldenFile.id,
      name: goldenFile.name,
      path: goldenFile.path,
      size: goldenFile.name.length,
      updatedAt: NOW,
    });
    goldenFile.chunks.forEach((chunk, index) => {
      chunkInserts.push({
        chunkIndex: index,
        chunkSize: chunk.content.length,
        chunkType: 'text',
        content: chunk.content,
        contentHash: `hash-${chunk.id}`,
        createdAt: NOW,
        embedding: chunk.embedding,
        embeddingHash: `embed-${chunk.id}`,
        embeddingSetId,
        embeddingUpdatedAt: NOW,
        fileRecordId: goldenFile.id,
        id: chunk.id,
        tokenCount: countTokensHeuristic(chunk.content),
        updatedAt: NOW,
      });
    });
  }
  await chunkRepo.insertMany(chunkInserts);
}

async function seedHybridDataset(
  db: PGlite,
  dataset: HybridGoldenDataset
): Promise<{ chunkRepo: FileChunkRepository; embeddingSetId: string; foreignChunkIds: string[] }> {
  await migrate(db);
  const chunkRepo = new FileChunkRepository(db);
  const fileRepo = new FileRecordRepository(db);
  const setRepo = new EmbeddingSetsRepository(db);

  const { modelKey, modelId, dimensions, distance } = dataset.embeddingSet;
  const embeddingSet = await setRepo.getOrCreateSet(modelKey, modelId, dimensions, distance);
  await seedGoldenFiles(chunkRepo, fileRepo, dataset.files, embeddingSet.id);

  // Seed the foreign-set decoys under a SEPARATE embedding set: an unscoped
  // keyword arm would fuse them in (they top BM25 for every query).
  const foreignSet = await setRepo.getOrCreateSet(
    `${modelKey}-foreign`,
    `${modelId}-foreign`,
    dimensions,
    distance
  );
  await seedGoldenFiles(chunkRepo, fileRepo, dataset.foreignSetFiles, foreignSet.id);
  const foreignChunkIds = dataset.foreignSetFiles.flatMap((goldenFile) =>
    goldenFile.chunks.map((chunk) => chunk.id)
  );

  return { chunkRepo, embeddingSetId: embeddingSet.id, foreignChunkIds };
}

function scoreRank(
  topChunkIds: string[],
  expectedChunkId: string
): {
  precisionAt1: number;
  reciprocalRank: number;
} {
  const rankIndex = topChunkIds.indexOf(expectedChunkId);
  return {
    precisionAt1: rankIndex === 0 ? 1 : 0,
    reciprocalRank: rankIndex === -1 ? 0 : 1 / (rankIndex + 1),
  };
}

function meanArmScore(
  queryResults: HybridEvaluationQueryResult[],
  pick: (result: HybridEvaluationQueryResult) => string[]
): HybridEvaluationArmScore {
  const total = queryResults.length;
  if (total === 0) {
    return { meanPrecisionAt1: 0, meanReciprocalRank: 0 };
  }
  let precisionSum = 0;
  let reciprocalSum = 0;
  for (const result of queryResults) {
    const score = scoreRank(pick(result), result.expectedChunkId);
    precisionSum += score.precisionAt1;
    reciprocalSum += score.reciprocalRank;
  }
  return {
    meanPrecisionAt1: precisionSum / total,
    meanReciprocalRank: reciprocalSum / total,
  };
}

function buildFailures(
  queryResults: HybridEvaluationQueryResult[],
  arms: HybridEvaluationReport['arms'],
  thresholds: HybridEvaluationThresholds,
  foreignChunkIds: readonly string[]
): string[] {
  const failures: string[] = [];
  // Embedding-set scoping guard: the foreign-set decoys top BM25 for every
  // query, so any appearance in a fused list means the keyword arm ran
  // unscoped — fail loudly.
  const foreignSet = new Set(foreignChunkIds);
  for (const result of queryResults) {
    const leaked = result.hybridTopChunkIds.filter((id) => foreignSet.has(id));
    if (leaked.length > 0) {
      failures.push(
        `${result.id} fused chunk(s) from another embedding set: [${leaked.join(', ')}]`
      );
    }
  }
  for (const result of queryResults) {
    if (!result.passed) {
      failures.push(
        `${result.id} expected ${result.expectedChunkId} first in the fused list, got [${result.hybridTopChunkIds.join(', ')}]`
      );
    }
  }
  if (arms.hybrid.meanPrecisionAt1 < thresholds.minMeanPrecisionAt1) {
    failures.push(
      `hybrid mean precision@1 ${arms.hybrid.meanPrecisionAt1.toFixed(4)} < ${thresholds.minMeanPrecisionAt1}`
    );
  }
  if (arms.hybrid.meanReciprocalRank < thresholds.minMeanReciprocalRank) {
    failures.push(
      `hybrid MRR ${arms.hybrid.meanReciprocalRank.toFixed(4)} < ${thresholds.minMeanReciprocalRank}`
    );
  }
  // The dataset's design property: fusion must be doing the work. If EITHER
  // pure arm already ranks every target first, the golden set no longer
  // separates the arms and this eval gates nothing — fail loudly.
  if (arms.vectorOnly.meanPrecisionAt1 >= 1) {
    failures.push(
      'vector-only precision@1 reached 1: the golden set no longer separates the vector arm from the fusion'
    );
  }
  if (arms.lexicalOnly.meanPrecisionAt1 >= 1) {
    failures.push(
      'lexical-only precision@1 reached 1: the golden set no longer separates the lexical arm from the fusion'
    );
  }
  return failures;
}

export async function runHybridEvaluation(
  options: RunHybridEvaluationOptions = {}
): Promise<HybridEvaluationReport> {
  const dataset = options.dataset ?? hybridGoldenDataset;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const db = await wasmLoader.createPGlite(`memory://hybrid-eval-${crypto.randomUUID()}`);

  try {
    const { chunkRepo, embeddingSetId, foreignChunkIds } = await seedHybridDataset(db, dataset);
    const hybridService = new HybridSearchService(chunkRepo);
    const queryResults: HybridEvaluationQueryResult[] = [];

    for (const query of dataset.queries) {
      const [hybridResponse, vectorResults, lexicalResults] = await Promise.all([
        hybridService.search(query.text, query.embedding, {
          embeddingSetId,
          includeHeadline: false,
          limit: DEFAULT_LIMIT,
          vectorThreshold: VECTOR_THRESHOLD,
        }),
        chunkRepo.searchSimilar(query.embedding, {
          embeddingSetId,
          limit: DEFAULT_LIMIT,
          threshold: VECTOR_THRESHOLD,
        }),
        // Scoped like the hybrid's keyword arm so the baseline comparison is
        // apples-to-apples within the same embedding set.
        chunkRepo.fullTextSearch(query.text, {
          embeddingSetId,
          includeHeadline: false,
          limit: DEFAULT_LIMIT,
        }),
      ]);

      const hybridTopChunkIds = hybridResponse.results.map((result) => result.chunk.id);
      const hybridScore = scoreRank(hybridTopChunkIds, query.expectedChunkId);
      queryResults.push({
        expectedChunkId: query.expectedChunkId,
        hybridTopChunkIds,
        id: query.id,
        lexicalOnlyTopChunkIds: lexicalResults.map((result) => result.chunk.id),
        passed: hybridScore.precisionAt1 === 1,
        precisionAt1: hybridScore.precisionAt1,
        query: query.text,
        reciprocalRank: hybridScore.reciprocalRank,
        vectorOnlyTopChunkIds: vectorResults.map((result) => result.chunk.id),
      });
    }

    const arms: HybridEvaluationReport['arms'] = {
      hybrid: meanArmScore(queryResults, (result) => result.hybridTopChunkIds),
      lexicalOnly: meanArmScore(queryResults, (result) => result.lexicalOnlyTopChunkIds),
      vectorOnly: meanArmScore(queryResults, (result) => result.vectorOnlyTopChunkIds),
    };
    const failures = buildFailures(queryResults, arms, thresholds, foreignChunkIds);
    const passedQueryCount = queryResults.filter((result) => result.passed).length;

    return {
      arms,
      dataset: { name: dataset.name, version: dataset.version },
      failures,
      passed: failures.length === 0,
      queries: queryResults,
      summary: {
        failedQueries: queryResults.length - passedQueryCount,
        failureCount: failures.length,
        meanPrecisionAt1: arms.hybrid.meanPrecisionAt1,
        meanReciprocalRank: arms.hybrid.meanReciprocalRank,
        passedQueries: passedQueryCount,
        totalQueries: queryResults.length,
      },
      thresholds,
      timestamp: new Date().toISOString(),
    };
  } finally {
    await db.close();
  }
}

export function serializeHybridEvaluationReport(report: HybridEvaluationReport): string {
  return JSON.stringify(report, null, 2);
}
