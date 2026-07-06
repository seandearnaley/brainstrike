import { countEstimatedTokens } from '@brainstrike/utils/token-counting-heuristics';
import { describe, expect, it } from 'vitest';
import { ContextPacker, type ContextPackerChunk } from '../context-packer';

describe('ContextPacker', () => {
  it('packs chunks in order without exceeding the budget', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunks: ContextPackerChunk[] = [
      { id: 'a', content: 'alpha', tokenCount: 5 },
      { id: 'b', content: 'bravo', tokenCount: 7 },
      { id: 'c', content: 'charlie', tokenCount: 4 },
    ];

    const result = packer.pack(chunks);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['a', 'c']);
    expect(result.totalTokens).toBe(9);
    expect(result.remainingTokens).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('falls back to shared estimator token counts when missing', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const content = '12345678';
    const chunks: ContextPackerChunk[] = [{ id: 'a', content }];

    const result = packer.pack(chunks);

    expect(result.chunks[0]?.tokenCount).toBe(countEstimatedTokens(content));
  });

  it('preserves citation metadata and assigns ranks', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunks: ContextPackerChunk[] = [
      {
        id: 'x',
        content: 'snippet',
        tokenCount: 3,
        filePath: 'src/app.ts',
        fileName: 'app.ts',
        chunkIndex: 2,
        startOffset: 12,
        endOffset: 42,
        startLine: 3,
        endLine: 5,
        score: 0.91,
        metadata: { language: 'ts' },
      },
    ];

    const result = packer.pack(chunks);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      id: 'x',
      filePath: 'src/app.ts',
      fileName: 'app.ts',
      chunkIndex: 2,
      tokenCount: 3,
      score: 0.91,
      rank: 1,
    });
    expect(result.chunks[0]?.offsets).toEqual({ start: 12, end: 42 });
    expect(result.chunks[0]?.lineRange).toEqual({ start: 3, end: 5 });
    expect(result.chunks[0]?.metadata).toEqual({ language: 'ts' });
  });

  it('respects maxChunks when provided', () => {
    const packer = new ContextPacker({ budgetTokens: 100, maxChunks: 1 });
    const chunks: ContextPackerChunk[] = [
      { id: 'a', content: 'first', tokenCount: 1 },
      { id: 'b', content: 'second', tokenCount: 1 },
    ];

    const result = packer.pack(chunks);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['a']);
    expect(result.skipped).toBe(1);
  });

  it('handles empty input arrays', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });

    const result = packer.pack([]);

    expect(result.chunks).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.remainingTokens).toBe(10);
    expect(result.skipped).toBe(0);
  });

  it('falls back to shared estimator token counts for invalid token counts', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunks: ContextPackerChunk[] = [
      { id: 'a', content: 'abcde', tokenCount: -3 },
      { id: 'b', content: 'abcde', tokenCount: null },
      { id: 'c', content: 'abcde' },
    ];

    const result = packer.pack(chunks);
    const expected = countEstimatedTokens('abcde');

    expect(result.chunks.map((chunk) => chunk.tokenCount)).toEqual([expected, expected, expected]);
  });

  it('skips chunks when budget is zero', () => {
    const packer = new ContextPacker({ budgetTokens: 0 });
    const chunks: ContextPackerChunk[] = [{ id: 'a', content: 'alpha', tokenCount: 1 }];

    const result = packer.pack(chunks);

    expect(result.chunks).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.remainingTokens).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('skips chunks that exceed the budget while allowing later fits', () => {
    const packer = new ContextPacker({ budgetTokens: 5 });
    const chunks: ContextPackerChunk[] = [
      { id: 'a', content: 'oversize', tokenCount: 10 },
      { id: 'b', content: 'fits', tokenCount: 3 },
    ];

    const result = packer.pack(chunks);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['b']);
    expect(result.totalTokens).toBe(3);
    expect(result.skipped).toBe(1);
  });

  it('skips all chunks when the budget is too small for any content', () => {
    const packer = new ContextPacker({ budgetTokens: 1 });
    const chunks: ContextPackerChunk[] = [
      { id: 'a', content: 'alpha', tokenCount: 2 },
      { id: 'b', content: 'bravo', tokenCount: 3 },
    ];

    const result = packer.pack(chunks);

    expect(result.chunks).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.remainingTokens).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('throws for invalid budget tokens (%s)', (_label, value) => {
    expect(() => new ContextPacker({ budgetTokens: value })).toThrow(
      /ContextPacker: budgetTokens must be a finite non-negative number/
    );
  });

  it('throws when budget exceeds safe integer range', () => {
    expect(() => new ContextPacker({ budgetTokens: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /exceeds safe integer range/
    );
  });

  it('throws when chunk id is missing', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunk = { content: 'missing id' } as unknown as ContextPackerChunk;

    expect(() => packer.pack([chunk])).toThrow(/chunk id must be a non-empty string/);
  });

  it('throws when chunk content is missing', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunk = { id: 'chunk-1' } as unknown as ContextPackerChunk;

    expect(() => packer.pack([chunk])).toThrow(/chunk content must be a string/);
  });
});
