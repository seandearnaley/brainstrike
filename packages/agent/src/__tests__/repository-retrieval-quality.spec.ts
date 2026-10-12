import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRetrievalFixture } from '../evaluation/fixtures/repository-retrieval';
import {
  checkRetrievalImprovement,
  evaluateJudgedHits,
  fuseEvaluationHits,
  runRepositoryRetrievalEvaluation,
  validateFixtureSources,
} from '../evaluation/repository-retrieval';

const root = resolve(import.meta.dirname, '../../../..');
const hit = (id: string, path = 'src/a.ts', startLine = 10, endLine = 20) => ({
  chunkId: id,
  content: id,
  endLine,
  relativePath: path,
  score: 99,
  startLine,
});
const judged = {
  id: 'query',
  intent: 'Find refresh ownership',
  judgments: [
    {
      endLine: 15,
      evidence: 'refresh()',
      id: 'answer',
      rationale: 'This source owns refresh.',
      relativePath: 'src/a.ts',
      startLine: 12,
    },
  ],
  kind: 'semantic' as const,
  query: 'refresh stale content',
};

describe('repository retrieval quality', () => {
  it('ships at least 100 unique queries with source-grounded span judgments', () => {
    expect(repositoryRetrievalFixture.queries.length).toBeGreaterThanOrEqual(100);
    expect(new Set(repositoryRetrievalFixture.queries.map((q) => q.query)).size).toBe(
      repositoryRetrievalFixture.queries.length
    );
    expect(() =>
      validateFixtureSources(repositoryRetrievalFixture, (path) =>
        readFileSync(resolve(root, path), 'utf8')
      )
    ).not.toThrow();
  });
  it('rejects changed source rather than accepting stale judgments', () => {
    expect(() => validateFixtureSources(repositoryRetrievalFixture, () => 'changed')).toThrow(
      /source hash/
    );
  });
  it('does not credit a matching file outside the judged source span', () => {
    const result = evaluateJudgedHits(judged, [
      hit('wrong', 'src/a.ts', 1, 5),
      { ...hit('correct'), content: 'refresh()' },
    ]);
    expect(result.mrr).toBe(0.5);
    expect(result.recallAtK[1]).toBe(0);
    expect(result.recallAtK[10]).toBe(1);
  });
  it('requires answer evidence within a partial chunk sharing the judged line', () => {
    const result = evaluateJudgedHits(judged, [
      { ...hit('unrelated-fragment'), content: 'const value = 1;' },
      { ...hit('answer-fragment'), content: 'refresh()' },
    ]);
    expect(result.mrr).toBe(0.5);
    expect(result.recallAtK[1]).toBe(0);
    expect(result.recallAtK[10]).toBe(1);
  });
  it('deduplicates chunks while retaining original source ranks in RRF', () => {
    const hits = fuseEvaluationHits(
      { bm25: [hit('a'), hit('a'), hit('b')], vector: [hit('b'), hit('c')] },
      ['bm25', 'vector'],
      100
    );
    expect(hits.map((h) => h.chunkId)).toEqual(['b', 'a', 'c']);
    expect(hits[0]?.score).toBeCloseTo(1 / 63 + 1 / 61);
  });
  it('fails visibly if a requested fusion source is missing', () => {
    expect(() => fuseEvaluationHits({ bm25: [] }, ['bm25', 'vector'], 10)).toThrow(/vector/);
  });
  it('requires a 0.05 improvement without lowering the other metric', () => {
    expect(
      checkRetrievalImprovement({ mrr: 0.5, recallAt10: 0.5 }, { mrr: 0.5, recallAt10: 0.55 })
        .passed
    ).toBe(true);
    expect(
      checkRetrievalImprovement({ mrr: 0.5, recallAt10: 0.5 }, { mrr: 0.49, recallAt10: 0.56 })
        .passed
    ).toBe(false);
    expect(
      checkRetrievalImprovement({ mrr: 0.5, recallAt10: 0.5 }, { mrr: 0.54, recallAt10: 0.54 })
        .passed
    ).toBe(false);
  });
  it('rejects non-finite or out-of-range metrics', () => {
    expect(() =>
      checkRetrievalImprovement({ mrr: 0, recallAt10: Number.NaN }, { mrr: 1, recallAt10: 1 })
    ).toThrow(/metric/);
  });
  it('accepts exactly five points despite binary floating point subtraction', () => {
    expect(
      checkRetrievalImprovement({ mrr: 0.8, recallAt10: 0.8 }, { mrr: 0.8, recallAt10: 0.85 })
        .passed
    ).toBe(true);
    expect(
      checkRetrievalImprovement({ mrr: 0.8, recallAt10: 0.8 }, { mrr: 0.8, recallAt10: 0.849_999 })
        .passed
    ).toBe(false);
  });
  it('rejects an unpinned embedding profile before search starts', async () => {
    await expect(
      runRepositoryRetrievalEvaluation(repositoryRetrievalFixture, {
        chunking: { chunkLines: 20, kind: 'line' as const },
        corpusSources: repositoryRetrievalFixture.sources,
        profile: {
          device: 'wasm',
          dimensions: 384,
          dtype: 'fp32',
          modelId: 'model',
          normalization: 'l2',
          pooling: 'mean',
          revision: 'main',
          tokenCap: 256,
        },
        profileHash: 'a'.repeat(64),
        readSource: (path) => readFileSync(resolve(root, path), 'utf8'),
        search: async () => ({ candidateCount: 0, hits: [], profileHash: 'a'.repeat(64) }),
      })
    ).rejects.toThrow(/revision/);
  });
  it.each([
    ['cls', 'bm25 unavailable'],
    ['max', 'pooling'],
  ])('admits only mean or CLS pooling (%s)', async (pooling, failure) => {
    // BST-1939: a CLS-pooled model reaches the searches; any other pooling is refused first.
    await expect(
      runRepositoryRetrievalEvaluation(repositoryRetrievalFixture, {
        chunking: { chunkLines: 20, kind: 'line' as const },
        corpusSources: repositoryRetrievalFixture.sources,
        profile: {
          device: 'webgpu',
          dimensions: 384,
          dtype: 'fp16',
          modelId: 'model',
          normalization: 'l2',
          pooling: pooling as 'cls',
          revision: 'a'.repeat(40),
          tokenCap: 8192,
        },
        profileHash: 'a'.repeat(64),
        readSource: (path) => readFileSync(resolve(root, path), 'utf8'),
        search: async (arm) => {
          throw new Error(`${arm} unavailable`);
        },
      })
    ).rejects.toThrow(failure);
  });
  it('does not issue a quality report when a search source fails', async () => {
    await expect(
      runRepositoryRetrievalEvaluation(repositoryRetrievalFixture, {
        chunking: { chunkLines: 20, kind: 'line' as const },
        corpusSources: repositoryRetrievalFixture.sources,
        profile: {
          device: 'wasm',
          dimensions: 384,
          dtype: 'fp32',
          modelId: 'model',
          normalization: 'l2',
          pooling: 'mean',
          revision: 'a'.repeat(40),
          tokenCap: 256,
        },
        profileHash: 'a'.repeat(64),
        readSource: (path) => readFileSync(resolve(root, path), 'utf8'),
        search: async (arm) => {
          throw new Error(`${arm} unavailable`);
        },
      })
    ).rejects.toThrow('bm25 unavailable');
  });
  it('records all named streams and rejects false source content or a mixed profile', async () => {
    const query = repositoryRetrievalFixture.queries[0];
    if (!query) {
      throw new Error('Fixture needs a query');
    }
    const answer = query.judgments[0];
    if (!answer) {
      throw new Error('Fixture needs an answer');
    }
    const content = readFileSync(resolve(root, answer.relativePath), 'utf8');
    const sourceHit = {
      ...hit('source', answer.relativePath, answer.startLine, answer.endLine),
      content: (content.match(/[^\n]*\n|[^\n]+$/gu) ?? [])
        .slice(answer.startLine - 1, answer.endLine)
        .join(''),
    };
    const calls: string[] = [];
    const options = {
      chunking: { chunkLines: 20, kind: 'line' as const },
      corpusSources: repositoryRetrievalFixture.sources,
      profile: {
        device: 'wasm' as const,
        dimensions: 384 as const,
        dtype: 'fp32' as const,
        modelId: 'model',
        normalization: 'l2' as const,
        pooling: 'mean' as const,
        revision: 'a'.repeat(40),
        tokenCap: 256,
      },
      profileHash: 'a'.repeat(64),
      readSource: (path: string) => readFileSync(resolve(root, path), 'utf8'),
      search: async (arm: string, _query: string, limit: number) => {
        calls.push(`${arm}:${limit}`);
        return { candidateCount: 1, hits: [sourceHit], profileHash: 'a'.repeat(64) };
      },
    };
    const fixture = { ...repositoryRetrievalFixture, queries: [query] };
    const report = await runRepositoryRetrievalEvaluation(fixture, options);
    expect(calls).toEqual(['bm25:100', 'grep:100', 'trigram:100', 'vector:100']);
    expect(report.profile).toEqual(options.profile);
    expect(report.corpusSources).toEqual(options.corpusSources);
    expect(report.queries[0]?.pools.vector.hits[0]).toEqual(sourceHit);
    expect(report.modes.hybrid.meanRecallAtK[10]).toBe(1);
    expect(report.gate.passed).toBe(false);
    await expect(
      runRepositoryRetrievalEvaluation(fixture, {
        ...options,
        search: async () => ({
          candidateCount: 1,
          hits: [{ ...sourceHit, content: 'fabricated' }],
          profileHash: 'a'.repeat(64),
        }),
      })
    ).rejects.toThrow(/Invalid bm25 source hit/);
    await expect(
      runRepositoryRetrievalEvaluation(fixture, {
        ...options,
        search: async () => ({ candidateCount: 1, hits: [sourceHit], profileHash: 'b'.repeat(64) }),
      })
    ).rejects.toThrow(/Invalid bm25 candidate pool/);
  });
  it('validates partial-line canonical host offsets without line-chunk coercion', async () => {
    const query = repositoryRetrievalFixture.queries[0];
    const answer = query?.judgments[0];
    if (!(query && answer)) {
      throw new Error('Fixture needs a query and answer');
    }
    const source = readFileSync(resolve(root, answer.relativePath), 'utf8');
    const startOffset = source.indexOf(answer.evidence);
    const sourceHit = {
      ...hit('canonical', answer.relativePath, answer.startLine, answer.endLine),
      content: answer.evidence,
      endOffset: startOffset + answer.evidence.length,
      startOffset,
    };
    const chunking = {
      kind: 'canonical-host' as const,
      maxTokens: 256,
      maxTokensCap: 256,
      overlap: 32,
      producerSourceCommit: 'b'.repeat(40),
      tokenTrueSizing: true,
    };
    const options = {
      chunking,
      corpusSources: repositoryRetrievalFixture.sources,
      profile: {
        device: 'webgpu' as const,
        dimensions: 384 as const,
        dtype: 'fp16' as const,
        modelId: 'model',
        normalization: 'l2' as const,
        pooling: 'mean' as const,
        revision: 'a'.repeat(40),
        tokenCap: 256,
      },
      profileHash: 'a'.repeat(64),
      readSource: (path: string) => readFileSync(resolve(root, path), 'utf8'),
      search: async () => ({ candidateCount: 1, hits: [sourceHit], profileHash: 'a'.repeat(64) }),
    };
    const fixture = { ...repositoryRetrievalFixture, queries: [query] };
    const report = await runRepositoryRetrievalEvaluation(fixture, options);
    expect(report.chunking).toEqual(chunking);
    expect(report.queries[0]?.pools.vector.hits[0]).toEqual(sourceHit);
    expect(report.modes.hybrid.meanRecallAtK[10]).toBe(1);
    const { startOffset: omittedOffset, ...withoutOffset } = sourceHit;
    expect(omittedOffset).toBeGreaterThanOrEqual(0);
    for (const invalid of [
      { ...sourceHit, startOffset: startOffset + 1 },
      withoutOffset,
      { ...sourceHit, endOffset: source.length + 1 },
      { ...sourceHit, startLine: 1 },
    ]) {
      await expect(
        runRepositoryRetrievalEvaluation(fixture, {
          ...options,
          search: async () => ({ candidateCount: 1, hits: [invalid], profileHash: 'a'.repeat(64) }),
        })
      ).rejects.toThrow(/Invalid bm25 source hit/);
    }
  });
});
