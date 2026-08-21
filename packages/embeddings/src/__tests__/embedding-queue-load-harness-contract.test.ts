import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('embedding queue load harness contract', () => {
  const harnessPath = path.resolve(
    process.cwd(),
    'src/__tests__/embedding-queue-load.integration.test.ts'
  );
  const integrationConfigPath = path.resolve(process.cwd(), 'vitest.integration.config.mts');
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');

  it('ships a serialized real-PGlite load matrix for 1, 2, and 4 worker loops', () => {
    expect(existsSync(harnessPath)).toBe(true);

    const integrationConfig = readFileSync(integrationConfigPath, 'utf8');
    expect(integrationConfig).toContain("include: ['**/*.integration.test.*']");

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: { 'test:integration'?: unknown };
    };
    const integrationScript = packageJson.scripts?.['test:integration'];
    if (typeof integrationScript !== 'string') {
      throw new Error('Expected @brainstrike/embeddings to define a test:integration script.');
    }
    expect(integrationScript).toContain('--maxWorkers=1');
    expect(integrationScript).toContain('--no-file-parallelism');
  });
});
