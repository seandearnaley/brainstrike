import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('embedding input hash benchmark contract', () => {
  const benchmarkPath = path.resolve(
    process.cwd(),
    'src/__tests__/embedding-input-hash-benchmark.integration.test.ts'
  );

  it('ships the BST-393 relocation matrix and worker-path metrics', () => {
    expect(existsSync(benchmarkPath)).toBe(true);

    const source = readFileSync(benchmarkPath, 'utf8');
    expect(source).toContain('batchSizes = [1, 8, 32]');
    expect(source).toContain('contentLengths = [128, 4096]');
    expect(source).toContain('legacyWorkerHotPathMs');
    expect(source).toContain('persistedWorkerHotPathMs');
    expect(source).toContain('producerHashMs');
    expect(source).toContain('relocatedEndToEndMs');
  });
});
