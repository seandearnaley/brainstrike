import { countTokensHeuristic } from '@brainstrike/utils/token-counting-heuristics';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { retrievalGoldenDataset } from './fixtures/retrieval-golden';

interface RankedResult {
  filePath: string;
  similarity: number;
}

const NOW = new Date(0).toISOString();

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

describe('retrieval regression harness', () => {
  let db: PGlite;
  let chunkRepo: FileChunkRepository;
  let fileRepo: FileRecordRepository;
  let setRepo: EmbeddingSetsRepository;
  let embeddingSetId: string;
  let filePathById: Map<string, string>;

  beforeAll(async () => {
    db = await wasmLoader.createPGlite('memory://retrieval-harness');
    await migrate(db);
    chunkRepo = new FileChunkRepository(db);
    fileRepo = new FileRecordRepository(db);
    setRepo = new EmbeddingSetsRepository(db);

    const { modelKey, modelId, dimensions, distance } = retrievalGoldenDataset.embeddingSet;
    const embeddingSet = await setRepo.getOrCreateSet(modelKey, modelId, dimensions, distance);
    embeddingSetId = embeddingSet.id;

    filePathById = new Map();
    for (const file of retrievalGoldenDataset.files) {
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
    for (const file of retrievalGoldenDataset.files) {
      file.chunks.forEach((chunk, index) => {
        chunkInserts.push({
          id: chunk.id,
          fileRecordId: file.id,
          chunkIndex: index,
          content: chunk.content,
          contentHash: `hash-${chunk.id}`,
          tokenCount: countTokensHeuristic(chunk.content),
          chunkType: 'text',
          chunkSize: chunk.content.length,
          embedding: chunk.embedding,
          embeddingSetId,
          embeddingUpdatedAt: NOW,
          embeddingHash: `embed-${chunk.id}`,
          createdAt: NOW,
          updatedAt: NOW,
        });
      });
    }

    await chunkRepo.insertMany(chunkInserts);
  });

  afterAll(async () => {
    await db.close();
  });

  it('reports precision@1 for golden queries', async () => {
    const k = 1;
    const precisionScores: number[] = [];

    for (const query of retrievalGoldenDataset.queries) {
      const results = await chunkRepo.searchSimilar(query.embedding, {
        limit: 10,
        threshold: 0,
        embeddingSetId,
      });

      const ranked = buildTopFilePaths(results, filePathById, k);
      const expected = new Set(query.expectedFilePaths);
      const precision = precisionAtK(ranked, expected, k);

      precisionScores.push(precision);

      const summary = {
        id: query.id,
        query: query.text,
        precisionAt1: precision,
        topFiles: ranked.map((entry) => entry.filePath),
        expected: query.expectedFilePaths,
      };
      console.info('[retrieval-harness] query metrics', summary);

      expect(precision, `precision@1 for ${query.id}`).toBe(1);
    }

    const averagePrecision =
      precisionScores.reduce((total, value) => total + value, 0) / precisionScores.length;

    console.info('[retrieval-harness] summary', {
      precisionAt1: Number(averagePrecision.toFixed(3)),
      totalQueries: retrievalGoldenDataset.queries.length,
    });

    expect(averagePrecision).toBe(1);
  });
});
