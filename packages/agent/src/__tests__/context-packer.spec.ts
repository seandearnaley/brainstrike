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

  it('falls back to heuristic token estimates when missing', () => {
    const packer = new ContextPacker({ budgetTokens: 10 });
    const chunks: ContextPackerChunk[] = [{ id: 'a', content: '12345678' }];

    const result = packer.pack(chunks);

    expect(result.chunks[0]?.tokenCount).toBe(2);
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
});
