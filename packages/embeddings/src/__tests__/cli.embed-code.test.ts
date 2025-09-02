import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy on fs methods used by CLI
const writeFileSync = vi.fn();
const readFileSync = vi.fn();
const statSync = vi.fn(() => ({ size: 10 }));
vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSync(...args),
  writeFileSync: (...args: unknown[]) => writeFileSync(...args),
  statSync: (...args: unknown[]) => statSync(...args),
}));

// Mock glob to return a synthetic list
vi.mock('glob', () => ({
  glob: vi.fn(async () => ['a.ts', 'b.ts'] as string[]),
}));

// Avoid heavy model init by stubbing the service used by CLI (no original import)
vi.mock('../bge-m3-service', () => {
  class DummyService {
    async initializeWithModel() {}
    async generateEmbedding(text: string) {
      const n = Math.max(3, Math.min(5, text.length));
      return {
        embedding: Array.from({ length: n }, (_, i) => i * 0.1),
        dimensions: n,
        model: 'dummy',
      };
    }
    async dispose() {}
  }
  return { SimpleEmbeddingService: DummyService };
});

describe('CodeEmbeddingCLI basics', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('splits content into chunks with overlap and detects language', async () => {
    const { CodeEmbeddingCLI } = await import('../cli/embed-code');
    const cli = new CodeEmbeddingCLI({
      rootDir: '.',
      format: 'json',
      maxLines: 2,
      chunkOverlap: 1,
    });
    const chunks = cli.splitIntoChunks('a\nb\nc\nd', 'file.ts');
    expect(chunks.length).toBeGreaterThan(1);
    expect(cli.detectLanguage('x.tsx')).toBe('typescript');
  });

  it('processes files and saves JSON and CSV outputs', async () => {
    const { CodeEmbeddingCLI } = await import('../cli/embed-code');
    const cli = new CodeEmbeddingCLI({
      rootDir: '/proj',
      format: 'json',
      verbose: true,
      maxLines: 3,
    });

    // stub reads for two files
    readFileSync.mockImplementation((p: string) => {
      if (String(p).endsWith('a.ts')) return 'console.log(1)';
      if (String(p).endsWith('b.ts')) return 'console.log(2)';
      return '';
    });

    const embeddings = await cli.processFiles();
    expect(embeddings.length).toBeGreaterThan(0);

    // Save JSON
    writeFileSync.mockClear();
    const jsonPath = path.join('/tmp', 'emb.json');
    await cli.saveEmbeddings(embeddings.map((e) => ({ ...e, embedding: [0.1, 0.2, 0.3] })));
    // No output configured yet => no write
    expect(writeFileSync).not.toHaveBeenCalled();

    // Now with output
    const cliCsv = new CodeEmbeddingCLI({ rootDir: '/proj', format: 'csv', output: jsonPath });
    await cliCsv.saveEmbeddings(
      embeddings.map((e) => ({ ...e, embedding: [0.1, 0.2, 0.3], content: 'x' }))
    );
    expect(writeFileSync).toHaveBeenCalled();
  });
});
