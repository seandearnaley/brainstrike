import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

function hasExactArgument(script: string, argument: string): boolean {
  return script.split(/\s+/u).includes(argument);
}

function hasPoolArgument(script: string): boolean {
  return script
    .split(/\s+/u)
    .some((argument) => argument === '--pool' || argument.startsWith('--pool='));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('embedding queue load harness contract', () => {
  const harnessPath = path.resolve(
    process.cwd(),
    'src/__tests__/embedding-queue-load.integration.test.ts'
  );
  const integrationConfigPath = path.resolve(process.cwd(), 'vitest.integration.config.mts');
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');

  it('keeps the load harness in the serialized integration lane', async () => {
    expect(existsSync(harnessPath)).toBe(true);

    const configUrl = pathToFileURL(integrationConfigPath).href;
    const configModule: unknown = await import(configUrl);
    if (!(isRecord(configModule) && isRecord(configModule['default']))) {
      throw new Error('Expected the embeddings integration Vitest config to export an object.');
    }
    const effectiveTestConfig = configModule['default']['test'];
    if (!isRecord(effectiveTestConfig)) {
      throw new Error('Expected the embeddings integration Vitest config to define test options.');
    }
    expect(effectiveTestConfig['include']).toEqual(['**/*.integration.test.*']);
    expect(effectiveTestConfig['pool']).toBe('forks');

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: { 'test:integration'?: unknown };
    };
    const integrationScript = packageJson.scripts?.['test:integration'];
    if (typeof integrationScript !== 'string') {
      throw new Error('Expected @brainstrike/embeddings to define a test:integration script.');
    }
    expect(hasExactArgument(integrationScript, '--maxWorkers=1')).toBe(true);
    expect(hasExactArgument(integrationScript, '--no-file-parallelism')).toBe(true);
    expect(hasPoolArgument(integrationScript)).toBe(false);
    expect(hasPoolArgument(`${integrationScript} --pool=threads`)).toBe(true);
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
