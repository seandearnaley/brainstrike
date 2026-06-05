import { describe, expect, it } from 'vitest';
import {
  batchArray,
  computeCosineSimilarity,
  computeOverfetchLimit,
  cosineToSearchSimilarity,
  FILE_CHUNK_SELECT_COLUMNS,
  FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY,
  MAX_OVERFETCH_LIMIT,
  parseEmbeddingLoose,
} from '../src/repositories/_shared';

describe('file_chunks column projections', () => {
  it('keeps full and dims-only lists identical except the embedding column', () => {
    expect(FILE_CHUNK_SELECT_COLUMNS).toContain('embedding::text AS embedding');
    expect(FILE_CHUNK_SELECT_COLUMNS).not.toContain('vector_dims');

    expect(FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY).toContain(
      'vector_dims(embedding) AS embedding_dims'
    );
    expect(FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY).not.toContain('embedding::text');

    // The two lists must differ ONLY in the embedding projection term — swapping
    // it back yields the full list. Guards against the column sets drifting.
    expect(
      FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY.replace(
        'vector_dims(embedding) AS embedding_dims',
        'embedding::text AS embedding'
      )
    ).toBe(FILE_CHUNK_SELECT_COLUMNS);
  });
});

describe('computeOverfetchLimit', () => {
  it('overfetches 10x the requested limit to improve rank quality', () => {
    expect(computeOverfetchLimit(20)).toBe(200);
    expect(computeOverfetchLimit(50)).toBe(500);
  });

  it('floors at 100 for tiny limits', () => {
    expect(computeOverfetchLimit(1)).toBe(100);
    expect(computeOverfetchLimit(5)).toBe(100);
  });

  it('caps at MAX_OVERFETCH_LIMIT so the 2,000 ceiling stays bounded on every platform', () => {
    // At the 2,000 result-limit ceiling, 10x would be 20,000 rows. The cap keeps
    // the worst-case materialization symmetric across Drizzle/PGlite/Electron.
    expect(MAX_OVERFETCH_LIMIT).toBe(10_000);
    expect(computeOverfetchLimit(2000)).toBe(10_000);
    expect(computeOverfetchLimit(100_000)).toBe(10_000);
  });
});

describe('parseEmbeddingLoose', () => {
  it('should parse JSON array format "[0.1, 0.2, 0.3]"', () => {
    const result = parseEmbeddingLoose('[0.1, 0.2, 0.3]');
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('should parse pgvector text format "[0.1,0.2,0.3]" without spaces', () => {
    const result = parseEmbeddingLoose('[0.1,0.2,0.3]');
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('should parse pgvector parentheses format "(0.1,0.2,0.3)"', () => {
    const result = parseEmbeddingLoose('(0.1,0.2,0.3)');
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('should parse comma-separated string "0.1,0.2,0.3"', () => {
    const result = parseEmbeddingLoose('0.1,0.2,0.3');
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('should handle native arrays', () => {
    const result = parseEmbeddingLoose([0.1, 0.2, 0.3]);
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('should return undefined for null or undefined input', () => {
    expect(parseEmbeddingLoose(null)).toBeUndefined();
    expect(parseEmbeddingLoose(undefined)).toBeUndefined();
    expect(parseEmbeddingLoose('')).toBeUndefined();
  });

  it('should return undefined for arrays with non-numeric values', () => {
    expect(parseEmbeddingLoose(['a', 'b', 'c'])).toBeUndefined();
    expect(parseEmbeddingLoose([1, 'two', 3])).toBeUndefined();
  });

  it('should return undefined for invalid string formats', () => {
    expect(parseEmbeddingLoose('not-a-valid-format')).toBeUndefined();
    expect(parseEmbeddingLoose('[a, b, c]')).toBeUndefined();
  });

  it('should handle edge cases with extra whitespace', () => {
    expect(parseEmbeddingLoose(' [ 0.1 , 0.2 , 0.3 ] ')).toEqual([0.1, 0.2, 0.3]);
    expect(parseEmbeddingLoose(' ( 0.1 , 0.2 , 0.3 ) ')).toEqual([0.1, 0.2, 0.3]);
  });

  it('should handle scientific notation', () => {
    expect(parseEmbeddingLoose('[1e-5, 2.5e-3, 3.14e2]')).toEqual([0.000_01, 0.0025, 314]);
  });

  it('should handle negative numbers', () => {
    expect(parseEmbeddingLoose('[-0.1, -0.2, 0.3]')).toEqual([-0.1, -0.2, 0.3]);
  });
});

describe('batchArray', () => {
  it('should batch array into chunks of specified size', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = batchArray(input, 3);
    expect(result).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]);
  });

  it('should handle array size equal to batch size', () => {
    const input = [1, 2, 3];
    const result = batchArray(input, 3);
    expect(result).toEqual([[1, 2, 3]]);
  });

  it('should handle array size less than batch size', () => {
    const input = [1, 2];
    const result = batchArray(input, 5);
    expect(result).toEqual([[1, 2]]);
  });

  it('should handle empty array', () => {
    const result = batchArray([], 5);
    expect(result).toEqual([]);
  });

  it('should handle batch size of 1', () => {
    const input = [1, 2, 3];
    const result = batchArray(input, 1);
    expect(result).toEqual([[1], [2], [3]]);
  });

  it('should work with 250 items (our actual batch size)', () => {
    const input = Array.from({ length: 600 }, (_, i) => i);
    const result = batchArray(input, 250);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(250);
    expect(result[1]).toHaveLength(250);
    expect(result[2]).toHaveLength(100);
  });
});

describe('computeCosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(computeCosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('should return 0 for orthogonal vectors', () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(computeCosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('should return cosine of angle between vectors', () => {
    const a = [1, 0];
    const b = [1, 1];
    // Angle is 45 degrees, cos(45°) ≈ 0.707
    expect(computeCosineSimilarity(a, b)).toBeCloseTo(Math.sqrt(2) / 2, 6);
  });

  it('should handle negative values correctly', () => {
    const a = [1, -1, 0];
    const b = [-1, 1, 0];
    expect(computeCosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it('should return NaN for mismatched dimensions', () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    expect(computeCosineSimilarity(a, b)).toBeNaN();
  });

  it('should return NaN for empty vectors', () => {
    const a: number[] = [];
    const b: number[] = [];
    expect(computeCosineSimilarity(a, b)).toBeNaN();
  });

  it('should return NaN for null or undefined vectors', () => {
    const a = [1, 2, 3];
    expect(computeCosineSimilarity(null as unknown as number[], a)).toBeNaN();
    expect(computeCosineSimilarity(a, undefined as unknown as number[])).toBeNaN();
  });

  it('should return NaN for zero vectors', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(computeCosineSimilarity(a, b)).toBeNaN();
  });

  it('should handle infinite values', () => {
    const a = [Number.POSITIVE_INFINITY, 1];
    const b = [1, 2];
    expect(computeCosineSimilarity(a, b)).toBeNaN();
  });

  it('should handle NaN values', () => {
    const a = [Number.NaN, 1];
    const b = [1, 2];
    expect(computeCosineSimilarity(a, b)).toBeNaN();
  });

  it('should work with typical embedding vectors', () => {
    const a = [0.1, 0.2, 0.3, 0.4, 0.5];
    const b = [0.15, 0.25, 0.35, 0.45, 0.55];
    const similarity = computeCosineSimilarity(a, b);
    expect(similarity).toBeGreaterThan(0.9);
    expect(similarity).toBeLessThanOrEqual(1);
  });

  it('should clamp results to [-1, 1] range', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6];
    const similarity = computeCosineSimilarity(a, b);
    expect(similarity).toBeGreaterThanOrEqual(-1);
    expect(similarity).toBeLessThanOrEqual(1);
    expect(similarity).toBeCloseTo(1, 6);
  });
});

describe('cosineToSearchSimilarity', () => {
  it('should convert cosine similarity 1 to search similarity 1', () => {
    expect(cosineToSearchSimilarity(1)).toBeCloseTo(1, 6);
  });

  it('should convert cosine similarity 0 to search similarity 0.5', () => {
    expect(cosineToSearchSimilarity(0)).toBeCloseTo(0.5, 6);
  });

  it('should convert cosine similarity -1 to search similarity 0', () => {
    expect(cosineToSearchSimilarity(-1)).toBeCloseTo(0, 6);
  });

  it('should handle NaN input', () => {
    expect(cosineToSearchSimilarity(Number.NaN)).toBe(0);
  });

  it('should handle infinite input', () => {
    expect(cosineToSearchSimilarity(Number.POSITIVE_INFINITY)).toBe(0);
    expect(cosineToSearchSimilarity(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('should work with typical cosine similarities', () => {
    expect(cosineToSearchSimilarity(0.8)).toBeCloseTo(0.9, 6);
    expect(cosineToSearchSimilarity(-0.5)).toBeCloseTo(0.25, 6);
  });
});
