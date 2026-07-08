import { countTokensHeuristic } from '@brainstrike/text-splitter';
import { describe, expect, it } from 'vitest';
import { ContextPacker, type ContextPackerChunk } from '../context-packer';

describe('ContextPacker', () => {
  it('packs chunks in order without exceeding the budget', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunks: ContextPackerChunk[] = [
      { content: 'alpha', id: 'a', tokenCount: 5 },
      { content: 'bravo', id: 'b', tokenCount: 7 },
      { content: 'charlie', id: 'c', tokenCount: 4 },
    ];

    const result = packer.pack(chunks);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['a', 'c']);
    expect(result.totalTokens).toBe(9);
    expect(result.remainingTokens).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('falls back to heuristic token estimates when missing', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const content = '12345678';
    const chunks: ContextPackerChunk[] = [{ content, id: 'a' }];

    const result = packer.pack(chunks);

    expect(result.chunks[0]?.tokenCount).toBe(countTokensHeuristic(content));
  });

  it('preserves citation metadata and assigns ranks', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunks: ContextPackerChunk[] = [
      {
        chunkIndex: 2,
        content: 'snippet',
        endLine: 5,
        endOffset: 42,
        fileName: 'app.ts',
        filePath: 'src/app.ts',
        id: 'x',
        metadata: { language: 'ts' },
        score: 0.91,
        startLine: 3,
        startOffset: 12,
        tokenCount: 3,
      },
    ];

    const result = packer.pack(chunks);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      chunkIndex: 2,
      fileName: 'app.ts',
      filePath: 'src/app.ts',
      id: 'x',
      rank: 1,
      score: 0.91,
      tokenCount: 3,
    });
    expect(result.chunks[0]?.offsets).toEqual({ end: 42, start: 12 });
    expect(result.chunks[0]?.lineRange).toEqual({ end: 5, start: 3 });
    expect(result.chunks[0]?.metadata).toEqual({ language: 'ts' });
  });

  it('respects maxChunks when provided', () => {
    const packer = new ContextPacker({ budgetTokens: 100, maxChunks: 1 });
    const chunks: ContextPackerChunk[] = [
      { content: 'first', id: 'a', tokenCount: 1 },
      { content: 'second', id: 'b', tokenCount: 1 },
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

  it('falls back to heuristic token estimates for invalid token counts', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunks: ContextPackerChunk[] = [
      { content: 'abcd', id: 'a', tokenCount: -3 },
      { content: 'abcd', id: 'b', tokenCount: null },
      { content: 'abcd', id: 'c' },
    ];

    const result = packer.pack(chunks);
    const expected = countTokensHeuristic('abcd');

    expect(result.chunks.map((chunk) => chunk.tokenCount)).toEqual([expected, expected, expected]);
  });

  it('skips chunks when budget is zero', () => {
    const packer = new ContextPacker({ budgetTokens: 0 });
    const chunks: ContextPackerChunk[] = [{ content: 'alpha', id: 'a', tokenCount: 1 }];

    const result = packer.pack(chunks);

    expect(result.chunks).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.remainingTokens).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('skips chunks that exceed the budget while allowing later fits', () => {
    const packer = new ContextPacker({ budgetTokens: 5 });
    const chunks: ContextPackerChunk[] = [
      { content: 'oversize', id: 'a', tokenCount: 10 },
      { content: 'fits', id: 'b', tokenCount: 3 },
    ];

    const result = packer.pack(chunks);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['b']);
    expect(result.totalTokens).toBe(3);
    expect(result.skipped).toBe(1);
  });

  it('skips all chunks when the budget is too small for any content', () => {
    const packer = new ContextPacker({ budgetTokens: 1 });
    const chunks: ContextPackerChunk[] = [
      { content: 'alpha', id: 'a', tokenCount: 2 },
      { content: 'bravo', id: 'b', tokenCount: 3 },
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
