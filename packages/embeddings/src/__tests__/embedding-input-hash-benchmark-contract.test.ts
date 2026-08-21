import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('embedding input hash benchmark contract', () => {
  const benchmarkPath = path.resolve(
    process.cwd(),
    'src/__tests__/embedding-input-hash-benchmark.integration.test.ts'
  );
  const integrationConfigPath = path.resolve(process.cwd(), 'vitest.integration.config.mts');

  it('keeps the BST-393 harness in the serialized integration lane', () => {
    expect(existsSync(benchmarkPath)).toBe(true);

    const integrationConfig = readFileSync(integrationConfigPath, 'utf8');
    expect(integrationConfig).toContain("include: ['**/*.integration.test.*']");
  });
});
