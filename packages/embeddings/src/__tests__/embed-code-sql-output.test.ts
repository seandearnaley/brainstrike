import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_MODEL_CONFIG } from '../types';

const writeFileSync = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 10 })),
  writeFileSync,
}));

vi.mock('glob', () => ({
  glob: vi.fn(async () => [] as string[]),
}));

vi.mock('../bge-m3-service', () => {
  class DummyService {
    async initializeWithModel() {}
    async dispose() {}
  }

  return { SimpleEmbeddingService: DummyService };
});

describe('embed-code pgvector output', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('serializes every string field through a safe SQL literal path', async () => {
    const { CodeEmbeddingCLI } = await import('../cli/embed-code');
    const cli = new CodeEmbeddingCLI({
      rootDir: '/repo',
      format: 'pgvector',
      output: '/tmp/out.sql',
      modelConfig: FALLBACK_MODEL_CONFIG,
    });

    await cli.saveEmbeddings([
      {
        id: "chunk'1",
        filePath: "src/$code$/o'hare.ts",
        language: "type'script",
        startLine: 1,
        endLine: 3,
        content: "const label = '$code$';\nconsole.log(\"o'hare\");",
        embedding: [0.1, 0.2, 0.3],
        dimensions: 3,
        model: "local'gemma",
        timestamp: "2026-04-19T02:00:00.000'Z",
      },
    ]);

    expect(writeFileSync).toHaveBeenCalledTimes(1);

    const [, sqlContent] = writeFileSync.mock.calls[0] as [string, string];
    expect(sqlContent).not.toContain('VALUES ($code$');
    expect(sqlContent).toContain("'chunk''1'");
    expect(sqlContent).toContain("'src/$code$/o''hare.ts'");
    expect(sqlContent).toContain("'type''script'");
    expect(sqlContent).toContain("'const label = ''$code$'';\nconsole.log(\"o''hare\");'");
    expect(sqlContent).toContain("'local''gemma'");
    expect(sqlContent).toContain("'2026-04-19T02:00:00.000''Z'");
  });
});
