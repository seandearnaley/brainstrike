import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function hasExactArgument(script: string, argument: string): boolean {
  return script.split(/\s+/u).includes(argument);
}

describe('embedding queue load harness contract', () => {
  const harnessPath = path.resolve(
    process.cwd(),
    'src/__tests__/embedding-queue-load.integration.test.ts'
  );
  const baseConfigPath = path.resolve(process.cwd(), 'vitest.config.mts');
  const integrationConfigPath = path.resolve(process.cwd(), 'vitest.integration.config.mts');
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');

  it('keeps the load harness in the serialized integration lane', () => {
    expect(existsSync(harnessPath)).toBe(true);

    const integrationConfig = readFileSync(integrationConfigPath, 'utf8');
    expect(integrationConfig).toContain("include: ['**/*.integration.test.*']");
    const baseConfig = readFileSync(baseConfigPath, 'utf8');
    expect(baseConfig).toContain("pool: 'forks'");

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: { 'test:integration'?: unknown };
    };
    const integrationScript = packageJson.scripts?.['test:integration'];
    if (typeof integrationScript !== 'string') {
      throw new Error('Expected @brainstrike/embeddings to define a test:integration script.');
    }
    expect(hasExactArgument(integrationScript, '--maxWorkers=1')).toBe(true);
    expect(hasExactArgument(integrationScript, '--no-file-parallelism')).toBe(true);
    // Pin the equals form so a widened worker count cannot satisfy the same
    // exact-token check through substring matching.
    expect(
      hasExactArgument(
        integrationScript.replace('--maxWorkers=1', '--maxWorkers=10'),
        '--maxWorkers=1'
      )
    ).toBe(false);
  });
});
