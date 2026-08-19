import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

interface RetentionResult {
  readonly batchPayloadBytes: number;
  readonly dimensions: number;
  readonly expectedBatchCount: number;
  readonly inputCount: number;
  readonly maxArrayBufferDeltaBytes: number;
  readonly peakArrayBufferDeltaBytes: number;
  readonly streamedPayloadBytes: number;
}

function withExposedGarbageCollection(nodeOptions: string | undefined): string {
  const existing = nodeOptions?.trim();
  if (!existing) {
    return '--expose-gc';
  }
  if (/(?:^|\s)--expose-gc(?:\s|$)/.test(existing)) {
    return existing;
  }
  return `${existing} --expose-gc`;
}

function parseRetentionResult(stdout: string): RetentionResult {
  const prefix = 'BST372_CURRENT_RETENTION_RESULT ';
  const matches = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as RetentionResult);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one BST372_CURRENT_RETENTION_RESULT line, received ${matches.length}.`
    );
  }
  const result = matches[0];
  if (!result) {
    throw new Error('BST-372 current retention result was missing after parsing.');
  }
  return result;
}

it('runs the current-production physical retention regression in the normal unit suite', {
  timeout: 30_000,
}, () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const require = createRequire(import.meta.url);
  const vitestPackagePath = require.resolve('vitest/package.json');
  const vitestCliPath = join(dirname(vitestPackagePath), 'vitest.mjs');
  const child = spawnSync(
    process.execPath,
    [
      vitestCliPath,
      'run',
      '--config',
      'bench/vitest.bst-372-current-retention.config.mts',
      '--pool=forks',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=verbose',
    ],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ['COVERAGE']: 'false',
        ['FORCE_COLOR']: '0',
        ['NODE_OPTIONS']: withExposedGarbageCollection(process.env['NODE_OPTIONS']),
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    }
  );
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  if (child.error) {
    throw child.error;
  }
  expect(child.status, output).toBe(0);

  const result = parseRetentionResult(child.stdout ?? '');
  expect(result.expectedBatchCount).toBe(512);
  expect(result.streamedPayloadBytes).toBe(result.inputCount * result.dimensions * 4);
  expect(result.peakArrayBufferDeltaBytes).toBeLessThanOrEqual(result.maxArrayBufferDeltaBytes);
  expect(result.maxArrayBufferDeltaBytes).toBe(result.batchPayloadBytes * 8);
});
