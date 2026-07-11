import { countTokensHeuristic } from '@brainstrike/utils/token-counting-heuristics';
import type { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrations/bootstrap.js';
import type { FileChunkInsert } from '../models/file-chunk.js';
import { FileChunkRepository } from '../repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../repositories/file-record-repository.js';
import { wasmLoader } from '../wasm-loader.js';
import {
  type LexicalGoldenDataset,
  lexicalChunkIdForFile,
  lexicalGoldenDataset,
} from './lexical-golden.js';

const NOW = new Date(0).toISOString();
const DEFAULT_LIMIT = 10;

export interface LexicalEvaluationThresholds {
  minMeanPrecisionAt1: number;
  minMeanReciprocalRank: number;
}

export interface LexicalEvaluationQueryResult {
  expectedChunkId: string;
  id: string;
  passed: boolean;
  precisionAt1: number;
  query: string;
  /** 1/rank of the expected chunk in the returned list; 0 when absent. */
  reciprocalRank: number;
  topChunkIds: string[];
}

export interface LexicalEvaluationReport {
  dataset: {
    name: string;
    version: string;
  };
  failures: string[];
  passed: boolean;
  queries: LexicalEvaluationQueryResult[];
  summary: {
    failureCount: number;
    failedQueries: number;
    meanPrecisionAt1: number;
    meanReciprocalRank: number;
    passedQueries: number;
    totalQueries: number;
  };
  thresholds: LexicalEvaluationThresholds;
  timestamp: string;
}

export interface RunLexicalEvaluationOptions {
  dataset?: LexicalGoldenDataset;
  thresholds?: Partial<LexicalEvaluationThresholds>;
}

/**
 * Strict by default, like the vector eval: the golden corpus is hand-designed
 * so the BM25-ordered lexical arm should place every expected chunk first.
 */
const DEFAULT_THRESHOLDS: LexicalEvaluationThresholds = {
  minMeanPrecisionAt1: 1,
  minMeanReciprocalRank: 1,
};

async function seedLexicalDataset(
  db: PGlite,
  dataset: LexicalGoldenDataset
): Promise<FileChunkRepository> {
  await migrate(db);
  const chunkRepo = new FileChunkRepository(db);
  const fileRepo = new FileRecordRepository(db);

  const chunkInserts: FileChunkInsert[] = [];
  for (const file of dataset.files) {
    await fileRepo.create({
      createdAt: NOW,
      id: file.id,
      name: file.name,
      path: file.path,
      size: file.content.length,
      updatedAt: NOW,
    });
    chunkInserts.push({
      chunkIndex: 0,
      chunkSize: file.content.length,
      chunkType: 'text',
      content: file.content,
      contentHash: `hash-${file.id}`,
      createdAt: NOW,
      fileRecordId: file.id,
      id: lexicalChunkIdForFile(file.id),
      tokenCount: countTokensHeuristic(file.content),
      updatedAt: NOW,
    });
  }

  await chunkRepo.insertMany(chunkInserts);
  return chunkRepo;
}

function buildFailures(
  queryResults: LexicalEvaluationQueryResult[],
  meanPrecisionAt1: number,
  meanReciprocalRank: number,
  thresholds: LexicalEvaluationThresholds
): string[] {
  const failures: string[] = [];
  for (const result of queryResults) {
    if (!result.passed) {
      failures.push(
        `${result.id} expected ${result.expectedChunkId} first, got [${result.topChunkIds.join(', ')}]`
      );
    }
  }
  if (meanPrecisionAt1 < thresholds.minMeanPrecisionAt1) {
    failures.push(
      `mean precision@1 ${meanPrecisionAt1.toFixed(4)} < ${thresholds.minMeanPrecisionAt1}`
    );
  }
  if (meanReciprocalRank < thresholds.minMeanReciprocalRank) {
    failures.push(`MRR ${meanReciprocalRank.toFixed(4)} < ${thresholds.minMeanReciprocalRank}`);
  }
  return failures;
}

export async function runLexicalEvaluation(
  options: RunLexicalEvaluationOptions = {}
): Promise<LexicalEvaluationReport> {
  const dataset = options.dataset ?? lexicalGoldenDataset;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const db = await wasmLoader.createPGlite(`memory://lexical-eval-${crypto.randomUUID()}`);

  try {
    const chunkRepo = await seedLexicalDataset(db, dataset);
    const queryResults: LexicalEvaluationQueryResult[] = [];

    for (const query of dataset.queries) {
      const results = await chunkRepo.fullTextSearch(query.text, {
        includeHeadline: false,
        limit: DEFAULT_LIMIT,
      });
      const topChunkIds = results.map((result) => result.chunk.id);
      const rankIndex = topChunkIds.indexOf(query.expectedChunkId);
      const reciprocalRank = rankIndex === -1 ? 0 : 1 / (rankIndex + 1);
      const precisionAt1 = rankIndex === 0 ? 1 : 0;
      queryResults.push({
        expectedChunkId: query.expectedChunkId,
        id: query.id,
        passed: precisionAt1 === 1,
        precisionAt1,
        query: query.text,
        reciprocalRank,
        topChunkIds,
      });
    }

    const total = queryResults.length;
    const meanPrecisionAt1 =
      total === 0 ? 0 : queryResults.reduce((sum, r) => sum + r.precisionAt1, 0) / total;
    const meanReciprocalRank =
      total === 0 ? 0 : queryResults.reduce((sum, r) => sum + r.reciprocalRank, 0) / total;
    const failures = buildFailures(queryResults, meanPrecisionAt1, meanReciprocalRank, thresholds);
    const passedQueryCount = queryResults.filter((result) => result.passed).length;

    return {
      dataset: { name: dataset.name, version: dataset.version },
      failures,
      passed: failures.length === 0,
      queries: queryResults,
      summary: {
        failedQueries: total - passedQueryCount,
        failureCount: failures.length,
        meanPrecisionAt1,
        meanReciprocalRank,
        passedQueries: passedQueryCount,
        totalQueries: total,
      },
      thresholds,
      timestamp: new Date().toISOString(),
    };
  } finally {
    await db.close();
  }
}

export function serializeLexicalEvaluationReport(report: LexicalEvaluationReport): string {
  return JSON.stringify(report, null, 2);
}
