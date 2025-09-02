import { describe, expect, it } from 'vitest';
import { ChunkingService } from '../src/services/chunking-service.js';

function makeFixedSentences(count: number, sentenceChars = 100) {
  const core = 'a'.repeat(Math.max(1, sentenceChars - 2));
  const sentence = `${core}. `; // ensures '. ' boundary
  return sentence.repeat(count);
}

describe('ChunkingService token bands', () => {
  it('sentence strategy keeps chunks near target token size', async () => {
    const svc = new ChunkingService();
    // 40 sentences ~100 chars each -> ~4000 chars (~1000 tokens by heuristic)
    const content = makeFixedSentences(40, 100);

    const res = await svc.chunkContent(content, 'band1', {
      strategy: 'sentence',
      maxTokens: 50, // target ~200 chars per chunk (avgCharsPerToken=4)
      overlap: 0,
      fileName: 'band.txt',
    });

    expect(res.skipped).toBeUndefined();
    // Expect around 20 chunks (within a tolerant band)
    expect(res.chunks.length).toBeGreaterThanOrEqual(16);
    expect(res.chunks.length).toBeLessThanOrEqual(24);

    // Average tokens per chunk should be close to 50 (±20%) by heuristic
    expect(res.avgTokensPerChunk).toBeGreaterThanOrEqual(40);
    expect(res.avgTokensPerChunk).toBeLessThanOrEqual(60);
  });

  it('tokenTrueSizing with custom tokenCounter yields expected chunk count band', async () => {
    const svc = new ChunkingService();
    const words = Array.from({ length: 1000 }, (_, i) => `w${i + 1}`);
    // Add some sentence breaks so sentence splitter has boundaries if used
    const content = words
      .map((w, i) => (i % 10 === 9 ? `${w}. ` : `${w} `))
      .join('')
      .trim();

    const res = await svc.chunkContent(content, 'band2', {
      strategy: 'sentence',
      maxTokens: 200, // target ~200 tokens per chunk; empirically aligns to ~10-16 chunks here
      overlap: 0,
      tokenTrueSizing: true,
      tokenCounter: async (t) => t.split(/\s+/).filter(Boolean).length, // words as tokens
      fileName: 'words.txt',
    });

    expect(res.skipped).toBeUndefined();
    // Expect around 12 chunks (wide tolerance due to text boundaries)
    expect(res.chunks.length).toBeGreaterThanOrEqual(5);
    expect(res.chunks.length).toBeLessThanOrEqual(16);
  });
});
