import { describe, expect, it } from 'vitest';
import { RecursiveTextSplitter, splitTextRecursively } from '../index.js';

describe('@brainstrike/text-splitter', () => {
  it('splits long text recursively with literal separators', async () => {
    const splitter = new RecursiveTextSplitter({
      chunkSize: 32,
      chunkOverlap: 4,
      separators: ['\n\n', '\n', '. ', ' ', ''],
    });

    const chunks = await splitter.splitText(
      'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.'
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(32);
    }
  });

  it('preserves overlapping context between neighboring chunks', () => {
    const chunks = splitTextRecursively('ab cd ef gh ij', {
      chunkSize: 6,
      chunkOverlap: 3,
      separators: [' ', ''],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.slice(-2)).toBe(chunks[1]?.slice(0, 2));
  });

  it('falls back to fixed-width splits when no separator matches', () => {
    const chunks = splitTextRecursively('abcdefghij', {
      chunkSize: 3,
      chunkOverlap: 0,
      separators: [''],
    });

    expect(chunks).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('supports regex separators', () => {
    const chunks = splitTextRecursively('a1b2c3d4e5f6', {
      chunkSize: 4,
      chunkOverlap: 0,
      separators: ['\\d'],
      isSeparatorRegex: true,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
  });

  it('throws on invalid chunk overlap', () => {
    expect(() =>
      splitTextRecursively('abc', {
        chunkSize: 4,
        chunkOverlap: 4,
      })
    ).toThrow('chunkOverlap must be smaller than chunkSize');
  });

  it('throws on invalid separator configuration', () => {
    expect(() =>
      splitTextRecursively('abc', {
        chunkSize: 4,
        chunkOverlap: 0,
        separators: [],
      })
    ).toThrow('separators must contain at least one entry');
  });
});
