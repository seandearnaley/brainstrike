import { describe, expect, it } from 'vitest';
import { batchArray, parseEmbeddingLoose } from '../src/repositories/_shared';

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
    expect(parseEmbeddingLoose('[1e-5, 2.5e-3, 3.14e2]')).toEqual([0.00001, 0.0025, 314]);
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
