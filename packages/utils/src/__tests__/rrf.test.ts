/**
 * Reciprocal Rank Fusion (RRF) Algorithm Tests
 *
 * Tests the RRF implementation for hybrid search combining
 * vector similarity and full-text search results.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateRRFContribution,
  createRankedList,
  type FusedResult,
  fuseRankedLists,
  fuseVectorAndFTS,
  normalizeRRFScores,
  type RankedList,
  RRF_K_DEFAULT,
} from '../rrf.js';

/** The item at `index`; a missing one fails the test instead of reading undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`No item at index ${index}`);
  }
  return item;
}

describe('RRF Algorithm', () => {
  describe('RRF_K_DEFAULT', () => {
    it('should be 60 (standard value)', () => {
      expect(RRF_K_DEFAULT).toBe(60);
    });
  });

  describe('calculateRRFContribution', () => {
    it('should calculate correct contribution for rank 1', () => {
      // 1/(60 + 1) = 1/61 ≈ 0.01639
      const contribution = calculateRRFContribution(1);
      expect(contribution).toBeCloseTo(1 / 61, 10);
    });

    it('should calculate correct contribution for rank 10', () => {
      // 1/(60 + 10) = 1/70 ≈ 0.01429
      const contribution = calculateRRFContribution(10);
      expect(contribution).toBeCloseTo(1 / 70, 10);
    });

    it('should use custom k value', () => {
      // 1/(30 + 1) = 1/31 ≈ 0.03226
      const contribution = calculateRRFContribution(1, 30);
      expect(contribution).toBeCloseTo(1 / 31, 10);
    });

    it('should apply weight multiplier', () => {
      // 2.0 * 1/(60 + 1) = 2/61 ≈ 0.03279
      const contribution = calculateRRFContribution(1, 60, 2.0);
      expect(contribution).toBeCloseTo(2 / 61, 10);
    });

    it('should throw error for rank < 1', () => {
      expect(() => calculateRRFContribution(0)).toThrow('Rank must be >= 1');
      expect(() => calculateRRFContribution(-1)).toThrow('Rank must be >= 1');
    });

    it('should decrease contribution as rank increases', () => {
      const rank1 = calculateRRFContribution(1);
      const rank5 = calculateRRFContribution(5);
      const rank10 = calculateRRFContribution(10);
      const rank100 = calculateRRFContribution(100);

      expect(rank1).toBeGreaterThan(rank5);
      expect(rank5).toBeGreaterThan(rank10);
      expect(rank10).toBeGreaterThan(rank100);
    });
  });

  describe('fuseRankedLists', () => {
    it('should fuse empty lists', () => {
      const result = fuseRankedLists([]);
      expect(result).toEqual([]);
    });

    it('should handle single list', () => {
      const list: RankedList = {
        items: [
          { id: 'doc1', score: 0.95 },
          { id: 'doc2', score: 0.87 },
        ],
        source: 'vector',
      };

      const result = fuseRankedLists([list]);

      expect(result).toHaveLength(2);
      expect(at(result, 0).id).toBe('doc1');
      expect(at(result, 1).id).toBe('doc2');
      expect(at(result, 0).sourceCount).toBe(1);
      expect(at(result, 0).contributions).toHaveLength(1);
      expect(at(at(result, 0).contributions, 0).source).toBe('vector');
      expect(at(at(result, 0).contributions, 0).rank).toBe(1);
    });

    it('should fuse two lists with overlapping items', () => {
      const vectorList: RankedList = {
        items: [
          { id: 'doc1', score: 0.95 },
          { id: 'doc2', score: 0.87 },
          { id: 'doc3', score: 0.82 },
        ],
        source: 'vector',
      };

      const ftsList: RankedList = {
        items: [
          { id: 'doc2', score: 15.2 },
          { id: 'doc4', score: 12.8 },
          { id: 'doc1', score: 8.5 },
        ],
        source: 'fts',
      };

      const result = fuseRankedLists([vectorList, ftsList]);

      // doc1: rank 1 in vector + rank 3 in fts
      // doc2: rank 2 in vector + rank 1 in fts
      // Both appear in 2 sources, doc2 should rank higher (better combined rank)
      expect(result.find((r) => r.id === 'doc2')?.sourceCount).toBe(2);
      expect(result.find((r) => r.id === 'doc1')?.sourceCount).toBe(2);
      expect(result.find((r) => r.id === 'doc3')?.sourceCount).toBe(1);
      expect(result.find((r) => r.id === 'doc4')?.sourceCount).toBe(1);

      // doc2 should have higher RRF score than doc1
      // doc2: 1/62 + 1/61 = 0.01613 + 0.01639 = 0.03252
      // doc1: 1/61 + 1/63 = 0.01639 + 0.01587 = 0.03226
      const doc1Result = result.find((r) => r.id === 'doc1');
      const doc2Result = result.find((r) => r.id === 'doc2');
      expect(doc2Result?.rrfScore).toBeGreaterThan(doc1Result?.rrfScore ?? 0);
    });

    it('should sort results by RRF score descending', () => {
      const list1: RankedList = {
        items: [{ id: 'doc1' }, { id: 'doc2' }, { id: 'doc3' }],
        source: 'vector',
      };

      const list2: RankedList = {
        items: [{ id: 'doc3' }, { id: 'doc2' }, { id: 'doc1' }],
        source: 'fts',
      };

      const result = fuseRankedLists([list1, list2]);

      // doc2 is rank 2 in both, so should be highest
      // doc2: 1/62 + 1/62 = 2/62 ≈ 0.03226
      // doc1: 1/61 + 1/63 ≈ 0.03226
      // doc3: 1/63 + 1/61 ≈ 0.03226
      // Actually all have same score, but doc2 has consistently middle rank
      for (let i = 1; i < result.length; i++) {
        expect(at(result, i - 1).rrfScore).toBeGreaterThanOrEqual(at(result, i).rrfScore);
      }
    });

    it('should apply weight to sources', () => {
      const vectorList: RankedList = {
        items: [{ id: 'doc1' }, { id: 'doc2' }],
        source: 'vector',
        weight: 2.0, // Double weight
      };

      const ftsList: RankedList = {
        items: [{ id: 'doc2' }, { id: 'doc1' }],
        source: 'fts',
        weight: 1.0,
      };

      const result = fuseRankedLists([vectorList, ftsList]);

      // doc1: 2*1/61 + 1/62 = 0.03279 + 0.01613 = 0.04892
      // doc2: 2*1/62 + 1/61 = 0.03226 + 0.01639 = 0.04865
      // doc1 should be higher due to higher weight on vector where it's rank 1
      const doc1 = result.find((r) => r.id === 'doc1');
      const doc2 = result.find((r) => r.id === 'doc2');
      expect(doc1?.rrfScore).toBeGreaterThan(doc2?.rrfScore ?? 0);
    });

    it('should respect limit option', () => {
      const list: RankedList = {
        items: [{ id: 'doc1' }, { id: 'doc2' }, { id: 'doc3' }, { id: 'doc4' }, { id: 'doc5' }],
        source: 'vector',
      };

      const result = fuseRankedLists([list], { limit: 3 });
      expect(result).toHaveLength(3);
      expect(at(result, 0).id).toBe('doc1');
      expect(at(result, 2).id).toBe('doc3');
    });

    it('should respect minSourceCount option', () => {
      const vectorList: RankedList = {
        items: [{ id: 'doc1' }, { id: 'doc2' }, { id: 'doc3' }],
        source: 'vector',
      };

      const ftsList: RankedList = {
        items: [{ id: 'doc2' }, { id: 'doc4' }],
        source: 'fts',
      };

      const result = fuseRankedLists([vectorList, ftsList], { minSourceCount: 2 });

      // Only doc2 appears in both lists
      expect(result).toHaveLength(1);
      expect(at(result, 0).id).toBe('doc2');
      expect(at(result, 0).sourceCount).toBe(2);
    });

    it('should use custom k value', () => {
      const list: RankedList = {
        items: [{ id: 'doc1' }],
        source: 'vector',
      };

      const resultDefault = fuseRankedLists([list], { k: 60 });
      const resultSmallK = fuseRankedLists([list], { k: 10 });

      // Smaller k gives higher scores
      expect(at(resultSmallK, 0).rrfScore).toBeGreaterThan(at(resultDefault, 0).rrfScore);
    });

    it('should include contribution details', () => {
      const vectorList: RankedList = {
        items: [{ id: 'doc1', score: 0.95 }],
        source: 'vector',
      };

      const ftsList: RankedList = {
        items: [{ id: 'doc1', score: 12.5 }],
        source: 'fts',
      };

      const result = fuseRankedLists([vectorList, ftsList]);

      expect(at(result, 0).contributions).toHaveLength(2);

      const vectorContrib = at(result, 0).contributions.find((c) => c.source === 'vector');
      expect(vectorContrib?.rank).toBe(1);
      expect(vectorContrib?.originalScore).toBe(0.95);

      const ftsContrib = at(result, 0).contributions.find((c) => c.source === 'fts');
      expect(ftsContrib?.rank).toBe(1);
      expect(ftsContrib?.originalScore).toBe(12.5);
    });

    it('should handle items not in all lists', () => {
      const list1: RankedList = {
        items: [{ id: 'doc1' }, { id: 'doc2' }],
        source: 'source1',
      };

      const list2: RankedList = {
        items: [{ id: 'doc3' }, { id: 'doc4' }],
        source: 'source2',
      };

      const result = fuseRankedLists([list1, list2]);

      expect(result).toHaveLength(4);
      for (const r of result) {
        expect(r.sourceCount).toBe(1);
        expect(r.contributions).toHaveLength(1);
      }
    });
  });

  describe('fuseVectorAndFTS', () => {
    it('should be a convenience wrapper for fuseRankedLists', () => {
      const vectorResults = [
        { id: 'doc1', score: 0.95 },
        { id: 'doc2', score: 0.87 },
      ];

      const ftsResults = [
        { id: 'doc2', score: 15.2 },
        { id: 'doc1', score: 8.5 },
      ];

      const result = fuseVectorAndFTS(vectorResults, ftsResults);

      expect(result).toHaveLength(2);
      expect(result.every((r) => r.sourceCount === 2)).toBe(true);

      // Check that sources are named correctly
      const doc1 = result.find((r) => r.id === 'doc1');
      expect(doc1?.contributions.map((c) => c.source).sort()).toEqual(['fts', 'vector']);
    });

    it('should apply vectorWeight and ftsWeight', () => {
      const vectorResults = [{ id: 'doc1', score: 0.95 }];
      const ftsResults = [{ id: 'doc2', score: 15.2 }];

      const resultEqual = fuseVectorAndFTS(vectorResults, ftsResults);
      const resultVectorHeavy = fuseVectorAndFTS(vectorResults, ftsResults, {
        ftsWeight: 1.0,
        vectorWeight: 2.0,
      });

      // doc1 should have higher score when vector is weighted more
      const doc1Equal = resultEqual.find((r) => r.id === 'doc1')?.rrfScore ?? 0;
      const doc1Heavy = resultVectorHeavy.find((r) => r.id === 'doc1')?.rrfScore ?? 0;

      expect(doc1Heavy).toBeGreaterThan(doc1Equal);
    });

    it('should pass through RRF options', () => {
      const vectorResults = [
        { id: 'doc1', score: 0.95 },
        { id: 'doc2', score: 0.87 },
        { id: 'doc3', score: 0.82 },
      ];

      const ftsResults = [{ id: 'doc1', score: 15.2 }];

      const result = fuseVectorAndFTS(vectorResults, ftsResults, {
        limit: 2,
        minSourceCount: 1,
      });

      expect(result).toHaveLength(2);
    });
  });

  describe('normalizeRRFScores', () => {
    it('should handle empty results', () => {
      const result = normalizeRRFScores([]);
      expect(result).toEqual([]);
    });

    it('should normalize scores to 0-1 range', () => {
      const results: FusedResult[] = [
        { contributions: [], id: 'doc1', rrfScore: 0.04, sourceCount: 2 },
        { contributions: [], id: 'doc2', rrfScore: 0.02, sourceCount: 1 },
        { contributions: [], id: 'doc3', rrfScore: 0.01, sourceCount: 1 },
      ];

      const normalized = normalizeRRFScores(results);

      expect(at(normalized, 0).rrfScore).toBe(1.0); // Max score becomes 1.0
      expect(at(normalized, 1).rrfScore).toBe(0.5); // 0.02/0.04 = 0.5
      expect(at(normalized, 2).rrfScore).toBe(0.25); // 0.01/0.04 = 0.25
    });

    it('should handle results with max score of 0', () => {
      const results: FusedResult[] = [
        { contributions: [], id: 'doc1', rrfScore: 0, sourceCount: 1 },
      ];

      const normalized = normalizeRRFScores(results);
      expect(at(normalized, 0).rrfScore).toBe(0);
    });

    it('maps all-equal non-zero scores to 1.0 without producing NaN', () => {
      // When every fused score is identical the score range collapses (max ===
      // min). A range-based normalization would divide by zero → NaN; the guard
      // maps every item to the top of the range (1.0) instead. There is no
      // discriminating signal, so treating them all as top-ranked is correct.
      const results: FusedResult[] = [
        { contributions: [], id: 'doc1', rrfScore: 0.02, sourceCount: 1 },
        { contributions: [], id: 'doc2', rrfScore: 0.02, sourceCount: 1 },
        { contributions: [], id: 'doc3', rrfScore: 0.02, sourceCount: 1 },
      ];

      const normalized = normalizeRRFScores(results);

      for (const item of normalized) {
        expect(Number.isNaN(item.rrfScore)).toBe(false);
        expect(item.rrfScore).toBe(1.0);
      }
    });

    it('should preserve other properties', () => {
      const results: FusedResult[] = [
        {
          contributions: [{ contribution: 0.02, rank: 1, source: 'vector' }],
          id: 'doc1',
          rrfScore: 0.04,
          sourceCount: 2,
        },
      ];

      const normalized = normalizeRRFScores(results);

      expect(at(normalized, 0).id).toBe('doc1');
      expect(at(normalized, 0).sourceCount).toBe(2);
      expect(at(normalized, 0).contributions).toHaveLength(1);
    });
  });

  describe('createRankedList', () => {
    it('should create a ranked list from items with scores', () => {
      const items = [
        { id: 'doc1', score: 0.95 },
        { id: 'doc2', score: 0.87 },
        { id: 'doc3', score: 0.92 },
      ];

      const list = createRankedList(items, 'vector');

      expect(list.source).toBe('vector');
      expect(list.items).toHaveLength(3);
      // Should be sorted descending by default
      expect(at(list.items, 0).id).toBe('doc1'); // 0.95
      expect(at(list.items, 1).id).toBe('doc3'); // 0.92
      expect(at(list.items, 2).id).toBe('doc2'); // 0.87
    });

    it('should preserve original scores', () => {
      const items = [{ id: 'doc1', score: 0.95 }];
      const list = createRankedList(items, 'vector');

      expect(at(list.items, 0).score).toBe(0.95);
    });

    it('should apply weight option', () => {
      const items = [{ id: 'doc1', score: 0.95 }];
      const list = createRankedList(items, 'vector', { weight: 2.0 });

      expect(list.weight).toBe(2.0);
    });

    it('should respect limit option', () => {
      const items = [
        { id: 'doc1', score: 0.95 },
        { id: 'doc2', score: 0.87 },
        { id: 'doc3', score: 0.82 },
      ];

      const list = createRankedList(items, 'vector', { limit: 2 });
      expect(list.items).toHaveLength(2);
    });

    it('should skip sorting when sortDescending is false', () => {
      const items = [
        { id: 'doc1', score: 0.5 },
        { id: 'doc2', score: 0.95 },
        { id: 'doc3', score: 0.7 },
      ];

      const list = createRankedList(items, 'vector', { sortDescending: false });

      // Order should be preserved
      expect(at(list.items, 0).id).toBe('doc1');
      expect(at(list.items, 1).id).toBe('doc2');
      expect(at(list.items, 2).id).toBe('doc3');
    });
  });

  describe('integration: realistic hybrid search scenario', () => {
    it('should boost items that appear in both vector and FTS results', () => {
      // Simulate a search for "database optimization"
      // Vector search finds semantically similar content
      const vectorResults = [
        { id: 'article-about-db-performance', score: 0.92 },
        { id: 'sql-tuning-guide', score: 0.88 },
        { id: 'nosql-comparison', score: 0.85 },
        { id: 'general-programming-tips', score: 0.78 },
      ];

      // FTS finds exact keyword matches
      const ftsResults = [
        { id: 'database-optimization-101', score: 25.5 }, // Exact match but not in top vector
        { id: 'sql-tuning-guide', score: 18.2 }, // Also in vector results
        { id: 'db-admin-handbook', score: 15.0 },
        { id: 'article-about-db-performance', score: 8.5 }, // Also in vector results
      ];

      const result = fuseVectorAndFTS(vectorResults, ftsResults);

      // Items appearing in both should rank higher
      const sqlTuning = result.find((r) => r.id === 'sql-tuning-guide');
      const dbPerformance = result.find((r) => r.id === 'article-about-db-performance');
      const singleSourceItems = result.filter((r) => r.sourceCount === 1);

      // Both multi-source items should be near the top
      expect(sqlTuning?.sourceCount).toBe(2);
      expect(dbPerformance?.sourceCount).toBe(2);

      // Multi-source items should generally rank higher than single-source
      const avgMultiScore = (sqlTuning!.rrfScore + dbPerformance!.rrfScore) / 2;
      const avgSingleScore =
        singleSourceItems.reduce((sum, r) => sum + r.rrfScore, 0) / singleSourceItems.length;
      expect(avgMultiScore).toBeGreaterThan(avgSingleScore);
    });

    it('should support three or more ranking sources', () => {
      const vectorResults: RankedList = {
        items: [{ id: 'doc1' }, { id: 'doc2' }],
        source: 'vector',
      };

      const ftsResults: RankedList = {
        items: [{ id: 'doc2' }, { id: 'doc3' }],
        source: 'fts',
      };

      const recencyResults: RankedList = {
        items: [{ id: 'doc3' }, { id: 'doc1' }],
        source: 'recency',
        weight: 0.5, // Lower weight for recency
      };

      const result = fuseRankedLists([vectorResults, ftsResults, recencyResults]);

      expect(result).toHaveLength(3);

      // doc1: vector rank 1, recency rank 2
      // doc2: vector rank 2, fts rank 1
      // doc3: fts rank 2, recency rank 1
      // All have sourceCount = 2

      const doc1 = result.find((r) => r.id === 'doc1')!;
      const doc2 = result.find((r) => r.id === 'doc2')!;
      const doc3 = result.find((r) => r.id === 'doc3')!;

      expect(doc1.sourceCount).toBe(2);
      expect(doc2.sourceCount).toBe(2);
      expect(doc3.sourceCount).toBe(2);

      // Verify contributions are tracked correctly
      expect(doc1.contributions.map((c) => c.source).sort()).toEqual(['recency', 'vector']);
      expect(doc2.contributions.map((c) => c.source).sort()).toEqual(['fts', 'vector']);
      expect(doc3.contributions.map((c) => c.source).sort()).toEqual(['fts', 'recency']);
    });
  });
});
