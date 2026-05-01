import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeEmbeddingCLI as CodeEmbeddingCLIType } from '../cli/embed-code';
import { FALLBACK_MODEL_CONFIG } from '../types';

// Spy on fs methods used by CLI
const writeFileSync = vi.fn();
const readFileSync = vi.fn();
const statSync = vi.fn(() => ({ size: 10 }));
vi.mock('node:fs', () => ({
  readFileSync,
  writeFileSync,
  statSync,
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
    async generateDocEmbedding(text: string) {
      return this.generateEmbedding(text);
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
      modelConfig: FALLBACK_MODEL_CONFIG,
    });
    const chunks = cli.splitIntoChunks('a\nb\nc\nd', 'file.ts');
    expect(chunks).toEqual([
      { content: 'a\nb', startLine: 1, endLine: 2 },
      { content: 'b\nc', startLine: 2, endLine: 3 },
      { content: 'c\nd', startLine: 3, endLine: 4 },
    ]);
    expect(cli.detectLanguage('x.tsx')).toBe('typescript');
  });

  it('processes files and saves JSON and CSV outputs', async () => {
    const { CodeEmbeddingCLI } = await import('../cli/embed-code');
    const cli = new CodeEmbeddingCLI({
      rootDir: '/proj',
      format: 'json',
      verbose: true,
      maxLines: 3,
      chunkOverlap: 0,
      modelConfig: FALLBACK_MODEL_CONFIG,
    });

    // stub reads for two files
    readFileSync.mockImplementation((p: string) => {
      if (String(p).endsWith('a.ts')) {
        return 'console.log(1)';
      }
      if (String(p).endsWith('b.ts')) {
        return 'console.log(2)';
      }
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
    const cliCsv = new CodeEmbeddingCLI({
      rootDir: '/proj',
      format: 'csv',
      output: jsonPath,
      modelConfig: FALLBACK_MODEL_CONFIG,
    });
    await cliCsv.saveEmbeddings(
      embeddings.map((e) => ({ ...e, embedding: [0.1, 0.2, 0.3], content: 'x' }))
    );
    expect(writeFileSync).toHaveBeenCalled();
  });

  it('serializes pgvector SQL text fields without dollar-quote delimiters', async () => {
    const { CodeEmbeddingCLI } = await import('../cli/embed-code');
    type CodeEmbeddingForSave = Parameters<CodeEmbeddingCLIType['saveEmbeddings']>[0][number];
    const cli = new CodeEmbeddingCLI({
      rootDir: '/proj',
      format: 'pgvector',
      output: path.join('/tmp', 'embeddings.sql'),
      modelConfig: FALLBACK_MODEL_CONFIG,
    });
    const embedding = {
      id: "src/$code$/unsafe's:file.ts:1-3",
      filePath: "src/$code$/unsafe'file.ts",
      language: "type'script",
      startLine: 1,
      endLine: 3,
      content: "const value = '$code$';\nSELECT $$broken$$;\nO'Reilly",
      embedding: [0.1, 0.2, 0.3],
      dimensions: 3,
      model: "model'key",
      timestamp: '2026-04-29T19:12:19.086Z',
    } satisfies CodeEmbeddingForSave;

    await cli.saveEmbeddings([embedding]);

    const lastWrite = writeFileSync.mock.calls.at(-1);
    expect(lastWrite).toBeDefined();
    const sql = String(lastWrite?.[1]);
    expect(sql).not.toContain('$code$const value');
    expect(sql).not.toContain('Reilly$code$');
    expect(sql).toContain(
      "VALUES ('src/$code$/unsafe''s:file.ts:1-3', 'src/$code$/unsafe''file.ts', 'type''script', 1, 3, 'const value = ''$code$'';\nSELECT $$broken$$;\nO''Reilly', '[0.1,0.2,0.3]'::vector, 'model''key', '2026-04-29T19:12:19.086Z');"
    );
  });
});
