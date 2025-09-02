import { describe, expect, it } from 'vitest';
import { CHUNKING_CONFIG } from '../src/config/chunking-config.js';
import { ChunkingService } from '../src/services/chunking-service.js';

describe('ChunkingService (streaming)', () => {
  it('streams markdown with fenced code blocks intact', async () => {
    const svc = new ChunkingService();
    const md =
      '# Title\n\nIntro paragraph about things.\n\n## Section\n- a\n- b\n\n```ts\nexport function add(a: number, b: number) {\n  return a + b;\n}\n```\n\nMore prose.';

    const it = svc.chunkContentStream(md, 'f1', {
      strategy: 'recursive',
      fileName: 'doc.md',
    });
    const chunks = [] as string[];
    for await (const ch of it) chunks.push(ch.content);
    expect(chunks.length).toBeGreaterThan(0);
    const hasFence = chunks.some((c) => c.includes('```') && c.includes('add('));
    expect(hasFence).toBe(true);
  });

  it('skips files in node_modules via skip rules', async () => {
    const svc = new ChunkingService();
    const result = await svc.chunkContent('export const x=1', 'f2', {
      strategy: 'recursive',
      filePath: '/work/app/node_modules/lib/index.js',
    });
    expect(result.skipped).toBe(true);
  });

  it('skips binary-like content (NUL bytes present)', async () => {
    const svc = new ChunkingService();
    const result = await svc.chunkContent('abc\u0000def', 'f3', {
      strategy: 'sentence',
      fileName: 'bin.dat',
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('Binary content');
  });

  it('streams big files when allowLargeFiles=true despite size cap', async () => {
    const svc = new ChunkingService();
    const big = 'word. '.repeat(CHUNKING_CONFIG.maxChunkableSize / 5 + 2000);
    const it = svc.chunkContentStream(big, 'f4', {
      strategy: 'sentence',
      fileName: 'big.txt',
      allowLargeFiles: true,
    });
    const firstTwo: string[] = [];
    for await (const ch of it) {
      firstTwo.push(ch.content);
      if (firstTwo.length === 2) break;
    }
    expect(firstTwo.length).toBe(2);
  });

  it('uses provided tokenCounter for token counts', async () => {
    const svc = new ChunkingService();
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const counts: number[] = [];
    const it = svc.chunkContentStream(text, 'f5', {
      strategy: 'sentence',
      fileName: 'text.txt',
      tokenCounter: async (t) => t.split(/\s+/).filter(Boolean).length,
    });
    for await (const ch of it) counts.push(ch.tokenCount);
    expect(counts.length).toBeGreaterThan(0);
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    expect(counts[0]).toBe(wordCount);
  });

  it('honors tokenTrueSizing by invoking tokenCounter during sizing', async () => {
    const svc = new ChunkingService();
    const text = 'a sentence. '.repeat(200);
    let calls = 0;
    const it = svc.chunkContentStream(text, 'f6', {
      strategy: 'sentence',
      fileName: 'text.txt',
      tokenTrueSizing: true,
      tokenCounter: async (t) => {
        calls += 1;
        // simple word-count counter
        return t.split(/\s+/).filter(Boolean).length;
      },
    });
    // Consume a couple of chunks; tokenCounter should be called at least once
    let seen = 0;
    for await (const _ of it) {
      seen += 1;
      if (seen >= 2) break;
    }
    expect(calls).toBeGreaterThan(0);
  });
});
