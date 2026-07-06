import { countEstimatedTokens } from '@brainstrike/utils/token-counting-heuristics';
import type { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrations/bootstrap.js';
import type { FileChunkInsert } from '../models/file-chunk.js';
import { EmbeddingSetsRepository } from '../repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../repositories/file-record-repository.js';
import { wasmLoader } from '../wasm-loader.js';
import { type RetrievalGoldenDataset, retrievalGoldenDataset } from './retrieval-golden.js';

const NOW = new Date(0).toISOString();
const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0;

export interface RetrievalEvaluationThresholds {
  minMeanPrecisionAt1: number;
  minQueryPrecisionAt1: number;
}

export interface RetrievalEvaluationTopFile {
  filePath: string;
  similarity: number;
}

export interface RetrievalEvaluationQueryResult {
  expectedFilePaths: string[];
  id: string;
  passed: boolean;
  precisionAt1: number;
  query: string;
  topFiles: RetrievalEvaluationTopFile[];
}

export interface RetrievalEvaluationReport {
  dataset: {
    name: string;
    version: string;
  };
  failures: string[];
  passed: boolean;
  queries: RetrievalEvaluationQueryResult[];
  summary: {
    failureCount: number;
    failedQueries: number;
    meanPrecisionAt1: number;
    passedQueries: number;
    totalQueries: number;
  };
  thresholds: RetrievalEvaluationThresholds;
  timestamp: string;
}

export interface RunRetrievalEvaluationOptions {
  dataset?: RetrievalGoldenDataset;
  thresholds?: Partial<RetrievalEvaluationThresholds>;
}

interface RankedResult {
  filePath: string;
  similarity: number;
}

const DEFAULT_THRESHOLDS: RetrievalEvaluationThresholds = {
  minMeanPrecisionAt1: 1,
  minQueryPrecisionAt1: 1,
};

function buildTopFilePaths(
  results: Array<{ chunk: { fileRecordId: string }; similarity: number }>,
  filePathById: Map<string, string>,
  k: number
): RankedResult[] {
  const seen = new Set<string>();
  const ranked: RankedResult[] = [];

  for (const result of results) {
    const filePath = filePathById.get(result.chunk.fileRecordId);
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    ranked.push({ filePath, similarity: result.similarity });
    if (ranked.length >= k) {
      break;
    }
  }

  return ranked;
}

function precisionAtK(ranked: RankedResult[], expected: Set<string>, k: number): number {
  if (k <= 0) {
    return 0;
  }
  const hits = ranked.filter((entry) => expected.has(entry.filePath)).length;
  return hits / k;
}

async function seedRetrievalDataset(
  db: PGlite,
  dataset: RetrievalGoldenDataset
): Promise<{
  chunkRepo: FileChunkRepository;
  embeddingSetId: string;
  filePathById: Map<string, string>;
}> {
  await migrate(db);
  const chunkRepo = new FileChunkRepository(db);
  const fileRepo = new FileRecordRepository(db);
  const setRepo = new EmbeddingSetsRepository(db);

  const { modelKey, modelId, dimensions, distance } = dataset.embeddingSet;
  const embeddingSet = await setRepo.getOrCreateSet(modelKey, modelId, dimensions, distance);
  const filePathById = new Map<string, string>();

  for (const file of dataset.files) {
    await fileRepo.create({
      id: file.id,
      name: file.name,
      path: file.path,
      size: file.name.length,
      createdAt: NOW,
      updatedAt: NOW,
    });
    filePathById.set(file.id, file.path);
  }

  const chunkInserts: FileChunkInsert[] = [];
  for (const file of dataset.files) {
    file.chunks.forEach((chunk, index) => {
      chunkInserts.push({
        id: chunk.id,
        fileRecordId: file.id,
        chunkIndex: index,
        content: chunk.content,
        contentHash: `hash-${chunk.id}`,
        tokenCount: countEstimatedTokens(chunk.content),
        chunkType: 'text',
        chunkSize: chunk.content.length,
        embedding: chunk.embedding,
        embeddingSetId: embeddingSet.id,
        embeddingUpdatedAt: NOW,
        embeddingHash: `embed-${chunk.id}`,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
  }

  await chunkRepo.insertMany(chunkInserts);
  return { chunkRepo, embeddingSetId: embeddingSet.id, filePathById };
}

function buildFailures(
  queryResults: RetrievalEvaluationQueryResult[],
  meanPrecisionAt1: number,
  thresholds: RetrievalEvaluationThresholds
): string[] {
  const failures: string[] = [];
  for (const result of queryResults) {
    if (result.precisionAt1 < thresholds.minQueryPrecisionAt1) {
      failures.push(
        `${result.id} precision@1 ${result.precisionAt1.toFixed(4)} < ${thresholds.minQueryPrecisionAt1}`
      );
    }
  }
  if (meanPrecisionAt1 < thresholds.minMeanPrecisionAt1) {
    failures.push(
      `mean precision@1 ${meanPrecisionAt1.toFixed(4)} < ${thresholds.minMeanPrecisionAt1}`
    );
  }
  return failures;
}

export async function runRetrievalEvaluation(
  options: RunRetrievalEvaluationOptions = {}
): Promise<RetrievalEvaluationReport> {
  const dataset = options.dataset ?? retrievalGoldenDataset;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const db = await wasmLoader.createPGlite(`memory://retrieval-eval-${crypto.randomUUID()}`);

  try {
    const { chunkRepo, embeddingSetId, filePathById } = await seedRetrievalDataset(db, dataset);
    const queryResults: RetrievalEvaluationQueryResult[] = [];

    for (const query of dataset.queries) {
      const results = await chunkRepo.searchSimilar(query.embedding, {
        limit: DEFAULT_LIMIT,
        threshold: DEFAULT_THRESHOLD,
        embeddingSetId,
      });
      const topFiles = buildTopFilePaths(results, filePathById, DEFAULT_LIMIT);
      const precisionAt1 = precisionAtK(topFiles.slice(0, 1), new Set(query.expectedFilePaths), 1);
      queryResults.push({
        id: query.id,
        query: query.text,
        expectedFilePaths: query.expectedFilePaths,
        topFiles,
        precisionAt1,
        passed: precisionAt1 >= thresholds.minQueryPrecisionAt1,
      });
    }

    const meanPrecisionAt1 =
      queryResults.length === 0
        ? 0
        : queryResults.reduce((total, result) => total + result.precisionAt1, 0) /
          queryResults.length;
    const failures = buildFailures(queryResults, meanPrecisionAt1, thresholds);
    const passedQueryCount = queryResults.filter((result) => result.passed).length;

    return {
      dataset: { name: dataset.name, version: dataset.version },
      timestamp: new Date().toISOString(),
      thresholds,
      summary: {
        totalQueries: queryResults.length,
        passedQueries: passedQueryCount,
        failedQueries: queryResults.length - passedQueryCount,
        failureCount: failures.length,
        meanPrecisionAt1,
      },
      queries: queryResults,
      failures,
      passed: failures.length === 0,
    };
  } finally {
    await db.close();
  }
}

export function serializeRetrievalEvaluationReport(report: RetrievalEvaluationReport): string {
  return JSON.stringify(report, null, 2);
}
